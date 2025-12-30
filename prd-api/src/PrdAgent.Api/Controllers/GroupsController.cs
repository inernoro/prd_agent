using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
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
    private readonly IMessageRepository _messageRepository;
    private readonly ICacheManager _cache;
    private readonly ILogger<GroupsController> _logger;

    private static readonly TimeSpan GroupSessionExpiry = TimeSpan.FromMinutes(30);

    private static string? GetUserId(ClaimsPrincipal user)
    {
        // 兼容 JwtBearer 默认 claim 映射（sub/nameid）与自定义（sub）
        return user.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
               ?? user.FindFirst("sub")?.Value
               ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value
               ?? user.FindFirst("nameid")?.Value;
    }

    public GroupsController(
        IGroupService groupService,
        IDocumentService documentService,
        IUserService userService,
        ISessionService sessionService,
        IMessageRepository messageRepository,
        ICacheManager cache,
        ILogger<GroupsController> logger)
    {
        _groupService = groupService;
        _documentService = documentService;
        _userService = userService;
        _sessionService = sessionService;
        _messageRepository = messageRepository;
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

        var userId = GetUserId(User);
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

        var prdDocumentId = string.IsNullOrWhiteSpace(request.PrdDocumentId) ? null : request.PrdDocumentId!.Trim();
        ParsedPrd? document = null;
        if (!string.IsNullOrEmpty(prdDocumentId))
        {
            // 检查文档是否存在
            document = await _documentService.GetByIdAsync(prdDocumentId);
            if (document == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    ErrorCodes.DOCUMENT_NOT_FOUND, "PRD文档不存在"));
            }
        }

        var group = await _groupService.CreateAsync(
            ownerId: userId,
            prdDocumentId: prdDocumentId ?? "",
            groupName: (request.GroupName ?? document?.Title ?? "新建群组"),
            prdTitleSnapshot: document?.Title,
            prdTokenEstimateSnapshot: document?.TokenEstimate,
            prdCharCountSnapshot: document?.CharCount);

        var members = await _groupService.GetMembersAsync(group.GroupId);

        var response = new GroupResponse
        {
            GroupId = group.GroupId,
            GroupName = group.GroupName,
            PrdDocumentId = string.IsNullOrWhiteSpace(group.PrdDocumentId) ? null : group.PrdDocumentId,
            PrdTitle = document?.Title ?? group.PrdTitleSnapshot,
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

        var userId = GetUserId(User);
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

        var userId = GetUserId(User);
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

        if (string.IsNullOrWhiteSpace(group.PrdDocumentId))
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "群组未绑定PRD"));
        }

        // 关键校验：PRD 原文仅存缓存（默认30分钟）。缓存被清/过期后，群组仍有 prdDocumentId，
        // 但无法进入会话与对话。这里提前返回明确错误，避免后续 open_session 成功但 get_document 404。
        var prd = await _documentService.GetByIdAsync(group.PrdDocumentId);
        if (prd == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.DOCUMENT_NOT_FOUND,
                "PRD文档不存在或已过期"));
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
            PrdDocumentId = string.IsNullOrWhiteSpace(group.PrdDocumentId) ? null : group.PrdDocumentId,
            PrdTitle = document?.Title ?? group.PrdTitleSnapshot,
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
    /// 绑定 PRD 到群组（仅写入元数据快照；不存原文）
    /// </summary>
    [HttpPut("{groupId}/prd")]
    [ProducesResponseType(typeof(ApiResponse<GroupResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> BindPrd(string groupId, [FromBody] BindGroupPrdRequest request)
    {
        var (isValid, errorMessage) = request.Validate();
        if (!isValid)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, errorMessage!));
        }

        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        // 仅群主/管理员可绑定 PRD
        var user = await _userService.GetByIdAsync(userId);
        if (user == null)
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }
        if (user.Role != UserRole.ADMIN && group.OwnerId != userId)
        {
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅群主可绑定PRD"));
        }

        var prdDocumentId = request.PrdDocumentId.Trim();
        var document = await _documentService.GetByIdAsync(prdDocumentId);
        if (document == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "PRD文档不存在或已过期"));
        }

        await _groupService.BindPrdAsync(
            groupId,
            prdDocumentId,
            document.Title,
            document.TokenEstimate,
            document.CharCount);

        // 重新读取群组（避免返回旧值）
        group = await _groupService.GetByIdAsync(groupId);
        var members = await _groupService.GetMembersAsync(groupId);

        var response = new GroupResponse
        {
            GroupId = group!.GroupId,
            GroupName = group.GroupName,
            PrdDocumentId = prdDocumentId,
            PrdTitle = document.Title,
            InviteLink = $"prdagent://join/{group.InviteCode}",
            InviteCode = group.InviteCode,
            CreatedAt = group.CreatedAt,
            MemberCount = members.Count
        };

        return Ok(ApiResponse<GroupResponse>.Ok(response));
    }

    /// <summary>
    /// 解绑群组 PRD
    /// </summary>
    [HttpDelete("{groupId}/prd")]
    [ProducesResponseType(typeof(ApiResponse<GroupResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UnbindPrd(string groupId)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        // 仅群主/管理员可解绑
        var user = await _userService.GetByIdAsync(userId);
        if (user == null)
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }
        if (user.Role != UserRole.ADMIN && group.OwnerId != userId)
        {
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅群主可解绑PRD"));
        }

        await _groupService.UnbindPrdAsync(groupId);

        group = await _groupService.GetByIdAsync(groupId);
        var members = await _groupService.GetMembersAsync(groupId);

        var response = new GroupResponse
        {
            GroupId = group!.GroupId,
            GroupName = group.GroupName,
            PrdDocumentId = null,
            PrdTitle = null,
            InviteLink = $"prdagent://join/{group.InviteCode}",
            InviteCode = group.InviteCode,
            CreatedAt = group.CreatedAt,
            MemberCount = members.Count
        };

        return Ok(ApiResponse<GroupResponse>.Ok(response));
    }

    /// <summary>
    /// 获取用户的群组列表
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<List<GroupResponse>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetUserGroups()
    {
        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var groups = await _groupService.GetUserGroupsAsync(userId);
        var response = new List<GroupResponse>();

        foreach (var group in groups)
        {
            ParsedPrd? document = null;
            if (!string.IsNullOrWhiteSpace(group.PrdDocumentId))
            {
                document = await _documentService.GetByIdAsync(group.PrdDocumentId);
            }
            var members = await _groupService.GetMembersAsync(group.GroupId);

            response.Add(new GroupResponse
            {
                GroupId = group.GroupId,
                GroupName = group.GroupName,
                PrdDocumentId = string.IsNullOrWhiteSpace(group.PrdDocumentId) ? null : group.PrdDocumentId,
                PrdTitle = document?.Title ?? group.PrdTitleSnapshot,
                InviteLink = $"prdagent://join/{group.InviteCode}",
                InviteCode = group.InviteCode,
                CreatedAt = group.CreatedAt,
                MemberCount = members.Count
            });
        }

        return Ok(ApiResponse<List<GroupResponse>>.Ok(response));
    }

    /// <summary>
    /// 解散群组（仅群主/管理员可）
    /// </summary>
    [HttpDelete("{groupId}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Dissolve(string groupId)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        var user = await _userService.GetByIdAsync(userId);
        if (user == null)
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        if (user.Role != UserRole.ADMIN && group.OwnerId != userId)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅群主可解散群组"));
        }

        await _groupService.DissolveAsync(groupId);
        _logger.LogInformation("Group dissolved: {GroupId} by {UserId}", groupId, userId);

        return Ok(ApiResponse<object>.Ok(new object()));
    }

    /// <summary>
    /// 获取群组消息历史（分页，按时间升序返回）
    /// </summary>
    [HttpGet("{groupId}/messages")]
    [ProducesResponseType(typeof(ApiResponse<List<MessageResponse>>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetGroupMessages(
        string groupId,
        [FromQuery] int limit = 50,
        [FromQuery] DateTime? before = null)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        // 验证用户是群组成员
        var members = await _groupService.GetMembersAsync(groupId);
        if (!members.Any(m => m.UserId == userId))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "您不是该群组成员"));
        }

        var messages = await _messageRepository.FindByGroupAsync(groupId, before, limit);

        var result = messages.Select(m => new MessageResponse
        {
            Id = m.Id,
            Role = m.Role,
            Content = m.Content,
            ViewRole = m.ViewRole,
            Timestamp = m.Timestamp,
            TokenUsage = m.TokenUsage
        }).ToList();

        return Ok(ApiResponse<List<MessageResponse>>.Ok(result));
    }
}
