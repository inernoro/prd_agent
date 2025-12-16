using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 群组控制器
/// </summary>
[ApiController]
[Route("api/v1/groups")]
[Authorize]
public class GroupsController : ControllerBase
{
    private readonly IGroupService _groupService;
    private readonly IDocumentService _documentService;
    private readonly IUserService _userService;
    private readonly ISessionService _sessionService;
    private readonly ICacheManager _cache;
    private readonly ILogger<GroupsController> _logger;

    private static readonly TimeSpan GroupSessionExpiry = TimeSpan.FromMinutes(30);

    public GroupsController(
        IGroupService groupService,
        IDocumentService documentService,
        IUserService userService,
        ISessionService sessionService,
        ICacheManager cache,
        ILogger<GroupsController> logger)
    {
        _groupService = groupService;
        _documentService = documentService;
        _userService = userService;
        _sessionService = sessionService;
        _cache = cache;
        _logger = logger;
    }

    /// <summary>
    /// 创建群组
    /// </summary>
    [HttpPost]
    [ProducesResponseType(typeof(ApiResponse<GroupResponse>), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> Create([FromBody] CreateGroupRequest request)
    {
        // 验证请求参数
        var (isValid, errorMessage) = request.Validate();
        if (!isValid)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, errorMessage!));
        }

        var userId = User.FindFirst("sub")?.Value;
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        // 检查用户角色（仅PM可创建）
        var user = await _userService.GetByIdAsync(userId);
        if (user == null || (user.Role != UserRole.PM && user.Role != UserRole.ADMIN))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅产品经理可创建群组"));
        }

        // 检查文档是否存在
        var document = await _documentService.GetByIdAsync(request.PrdDocumentId);
        if (document == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.DOCUMENT_NOT_FOUND, "PRD文档不存在"));
        }

        var group = await _groupService.CreateAsync(
            ownerId: userId,
            prdDocumentId: request.PrdDocumentId,
            groupName: request.GroupName ?? document.Title,
            prdTitleSnapshot: document.Title,
            prdTokenEstimateSnapshot: document.TokenEstimate,
            prdCharCountSnapshot: document.CharCount);

        var members = await _groupService.GetMembersAsync(group.GroupId);

        var response = new GroupResponse
        {
            GroupId = group.GroupId,
            GroupName = group.GroupName,
            PrdDocumentId = group.PrdDocumentId,
            PrdTitle = document.Title,
            InviteLink = $"prdagent://join/{group.InviteCode}",
            InviteCode = group.InviteCode,
            CreatedAt = group.CreatedAt,
            MemberCount = members.Count
        };

        _logger.LogInformation("Group created: {GroupId} by {UserId}", group.GroupId, userId);

        return CreatedAtAction(nameof(GetGroup), new { groupId = group.GroupId },
            ApiResponse<GroupResponse>.Ok(response));
    }

    /// <summary>
    /// 加入群组
    /// </summary>
    [HttpPost("join")]
    [ProducesResponseType(typeof(ApiResponse<JoinGroupResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Join([FromBody] JoinGroupRequest request)
    {
        // 验证请求参数
        var (isValid, errorMessage) = request.Validate();
        if (!isValid)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, errorMessage!));
        }

        var userId = User.FindFirst("sub")?.Value;
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        try
        {
            var member = await _groupService.JoinAsync(request.InviteCode, userId, request.UserRole);
            var group = await _groupService.GetByIdAsync(member.GroupId);
            var document = group != null 
                ? await _documentService.GetByIdAsync(group.PrdDocumentId) 
                : null;
            var members = await _groupService.GetMembersAsync(member.GroupId);

            var response = new JoinGroupResponse
            {
                GroupId = member.GroupId,
                GroupName = group?.GroupName ?? "",
                PrdTitle = document?.Title,
                MemberCount = members.Count,
                JoinedAt = member.JoinedAt
            };

            _logger.LogInformation("User {UserId} joined group {GroupId}", userId, member.GroupId);

            return Ok(ApiResponse<JoinGroupResponse>.Ok(response));
        }
        catch (ArgumentException ex)
        {
            var errorCode = ex.Message switch
            {
                "邀请码无效" => ErrorCodes.INVALID_INVITE_LINK,
                "邀请码已过期" => ErrorCodes.INVITE_EXPIRED,
                "您已是该群组成员" => ErrorCodes.ALREADY_MEMBER,
                "群组已满" => ErrorCodes.GROUP_FULL,
                _ => ErrorCodes.INTERNAL_ERROR
            };
            return BadRequest(ApiResponse<object>.Fail(errorCode, ex.Message));
        }
    }

    /// <summary>
    /// 打开群组会话（用于桌面端进入群组后进行问答/引导）
    /// </summary>
    [HttpPost("{groupId}/session")]
    [ProducesResponseType(typeof(ApiResponse<OpenGroupSessionResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> OpenGroupSession(string groupId, [FromBody] OpenGroupSessionRequest request)
    {
        var (isValid, errorMessage) = request.Validate();
        if (!isValid)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, errorMessage!));
        }

        var userId = User.FindFirst("sub")?.Value;
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        // 校验群组存在
        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        // 校验成员关系（群主/成员均可）
        var isMember = await _groupService.IsMemberAsync(groupId, userId);
        if (!isMember)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "您不是该群组成员"));
        }

        // 复用同一用户在该群组的 session，避免重复创建
        var cacheKey = $"group:session:{groupId}:{userId}";
        var cachedSessionId = await _cache.GetAsync<string>(cacheKey);
        if (!string.IsNullOrEmpty(cachedSessionId))
        {
            var cachedSession = await _sessionService.GetByIdAsync(cachedSessionId);
            if (cachedSession != null)
            {
                await _cache.RefreshExpiryAsync(cacheKey, GroupSessionExpiry);

                return Ok(ApiResponse<OpenGroupSessionResponse>.Ok(new OpenGroupSessionResponse
                {
                    SessionId = cachedSession.SessionId,
                    GroupId = groupId,
                    DocumentId = cachedSession.DocumentId,
                    CurrentRole = cachedSession.CurrentRole
                }));
            }
        }

        // 创建新 session（绑定 groupId）
        var session = await _sessionService.CreateAsync(group.PrdDocumentId, groupId);
        session = await _sessionService.SwitchRoleAsync(session.SessionId, request.UserRole);

        await _cache.SetAsync(cacheKey, session.SessionId, GroupSessionExpiry);

        return Ok(ApiResponse<OpenGroupSessionResponse>.Ok(new OpenGroupSessionResponse
        {
            SessionId = session.SessionId,
            GroupId = groupId,
            DocumentId = session.DocumentId,
            CurrentRole = session.CurrentRole
        }));
    }

    /// <summary>
    /// 获取群组信息
    /// </summary>
    [HttpGet("{groupId}")]
    [ProducesResponseType(typeof(ApiResponse<GroupResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetGroup(string groupId)
    {
        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        var document = await _documentService.GetByIdAsync(group.PrdDocumentId);
        var members = await _groupService.GetMembersAsync(groupId);

        var response = new GroupResponse
        {
            GroupId = group.GroupId,
            GroupName = group.GroupName,
            PrdDocumentId = group.PrdDocumentId,
            PrdTitle = document?.Title,
            InviteLink = $"prdagent://join/{group.InviteCode}",
            InviteCode = group.InviteCode,
            CreatedAt = group.CreatedAt,
            MemberCount = members.Count
        };

        return Ok(ApiResponse<GroupResponse>.Ok(response));
    }

    /// <summary>
    /// 获取群组成员列表
    /// </summary>
    [HttpGet("{groupId}/members")]
    [ProducesResponseType(typeof(ApiResponse<List<GroupMemberResponse>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetMembers(string groupId)
    {
        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        var members = await _groupService.GetMembersAsync(groupId);
        var response = new List<GroupMemberResponse>();

        foreach (var member in members)
        {
            var user = await _userService.GetByIdAsync(member.UserId);
            if (user != null)
            {
                response.Add(new GroupMemberResponse
                {
                    UserId = user.UserId,
                    Username = user.Username,
                    DisplayName = user.DisplayName,
                    MemberRole = member.MemberRole,
                    JoinedAt = member.JoinedAt,
                    IsOwner = member.UserId == group.OwnerId
                });
            }
        }

        return Ok(ApiResponse<List<GroupMemberResponse>>.Ok(response));
    }

    /// <summary>
    /// 获取用户的群组列表
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<List<GroupResponse>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetUserGroups()
    {
        var userId = User.FindFirst("sub")?.Value;
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var groups = await _groupService.GetUserGroupsAsync(userId);
        var response = new List<GroupResponse>();

        foreach (var group in groups)
        {
            var document = await _documentService.GetByIdAsync(group.PrdDocumentId);
            var members = await _groupService.GetMembersAsync(group.GroupId);

            response.Add(new GroupResponse
            {
                GroupId = group.GroupId,
                GroupName = group.GroupName,
                PrdDocumentId = group.PrdDocumentId,
                PrdTitle = document?.Title,
                InviteLink = $"prdagent://join/{group.InviteCode}",
                InviteCode = group.InviteCode,
                CreatedAt = group.CreatedAt,
                MemberCount = members.Count
            });
        }

        return Ok(ApiResponse<List<GroupResponse>>.Ok(response));
    }
}
