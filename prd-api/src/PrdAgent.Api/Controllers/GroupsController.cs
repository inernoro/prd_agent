using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Json;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

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
    private readonly IGroupBotService _groupBotService;
    private readonly IDocumentService _documentService;
    private readonly IUserService _userService;
    private readonly ISessionService _sessionService;
    private readonly IMessageRepository _messageRepository;
    private readonly ICacheManager _cache;
    private readonly ILogger<GroupsController> _logger;
    private readonly MongoDbContext _db;
    private readonly IGroupMessageStreamHub _groupMessageStreamHub;
    private readonly IConfiguration _cfg;
    private readonly IGroupNameSuggestionService _groupNameSuggestionService;

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
        IGroupBotService groupBotService,
        IDocumentService documentService,
        IUserService userService,
        ISessionService sessionService,
        IMessageRepository messageRepository,
        ICacheManager cache,
        ILogger<GroupsController> logger,
        MongoDbContext db,
        IGroupMessageStreamHub groupMessageStreamHub,
        IConfiguration cfg,
        IGroupNameSuggestionService groupNameSuggestionService)
    {
        _groupService = groupService;
        _groupBotService = groupBotService;
        _documentService = documentService;
        _userService = userService;
        _sessionService = sessionService;
        _messageRepository = messageRepository;
        _cache = cache;
        _logger = logger;
        _db = db;
        _groupMessageStreamHub = groupMessageStreamHub;
        _cfg = cfg;
        _groupNameSuggestionService = groupNameSuggestionService;
    }

    private string? BuildAvatarUrl(User user)
    {
        return AvatarUrlBuilder.Build(_cfg, user);
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

        // 验证用户存在
        var user = await _userService.GetByIdAsync(userId);
        if (user == null)
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "用户不存在"));
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

        // 创建群后自动初始化默认机器人账号（PM/DEV/QA），并加入群成员（幂等）
        try
        {
            await _groupBotService.EnsureDefaultRoleBotsInGroupAsync(group.GroupId);
        }
        catch (Exception ex)
        {
            // 不阻断创建群主流程：失败时仍可手动调用 /bots/bootstrap
            _logger.LogWarning(ex, "Failed to auto bootstrap group bots: {GroupId}", group.GroupId);
        }

        var members = await _groupService.GetMembersAsync(group.GroupId);

        // 如果用户没有提供群名且有 PRD 文档，在后台异步生成群名
        if (string.IsNullOrWhiteSpace(request.GroupName) && !string.IsNullOrEmpty(prdDocumentId))
        {
            _groupNameSuggestionService.EnqueueGroupNameSuggestion(
                group.GroupId, 
                fileName: null, 
                prdDocumentId);
        }

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
    public async Task<IActionResult> OpenGroupSession(string groupId, [FromBody] OpenGroupSessionRequest request, CancellationToken ct = default)
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

        // QQ 群形态：单群单会话（复用同一 groupId 的会话线程）。
        // 会话不再按“用户+群”拆分，也不再把成员身份写进 session（避免互相覆盖）。
        var member = await _db.GroupMembers.Find(x => x.GroupId == groupId && x.UserId == userId).FirstOrDefaultAsync(ct);
        if (member == null)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "您不是该群组成员"));
        }

        var session = await _sessionService.CreateAsync(group.PrdDocumentId, groupId);

        return Ok(ApiResponse<OpenGroupSessionResponse>.Ok(new OpenGroupSessionResponse
        {
            SessionId = session.SessionId,
            GroupId = groupId,
            DocumentId = session.DocumentId,
            // currentRole 语义：当前用户的身份（用于提示词分组与默认回答 bot）
            CurrentRole = member.MemberRole
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
                var tags = member.Tags ?? new List<GroupMemberTag>();
                // 兼容旧数据：若 tags 缺失则按用户类型/角色补默认值
                if (tags.Count == 0)
                {
                    tags = user.UserType == UserType.Bot
                        ? BuildDefaultBotTags(user.BotKind ?? BotKind.DEV)
                        : BuildDefaultHumanTags(member.MemberRole);
                }
                response.Add(new GroupMemberResponse
                {
                    UserId = user.UserId,
                    Username = user.Username,
                    DisplayName = user.DisplayName,
                    MemberRole = member.MemberRole,
                    IsBot = user.UserType == UserType.Bot,
                    BotKind = user.UserType == UserType.Bot ? user.BotKind : null,
                    AvatarFileName = user.AvatarFileName,
                    AvatarUrl = BuildAvatarUrl(user),
                    Tags = tags.Select(t => new GroupMemberTagDto
                    {
                        Name = t.Name,
                        Role = t.Role
                    }).ToList(),
                    JoinedAt = member.JoinedAt,
                    IsOwner = member.UserId == group.OwnerId
                });
            }
        }

        return Ok(ApiResponse<List<GroupMemberResponse>>.Ok(response));
    }

    /// <summary>
    /// 初始化群内默认机器人账号（PM/DEV/QA），并加入群成员
    /// </summary>
    [HttpPost("{groupId}/bots/bootstrap")]
    [ProducesResponseType(typeof(ApiResponse<BootstrapGroupBotsResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> BootstrapBots(string groupId, [FromBody] BootstrapGroupBotsRequest? request)
    {
        var (isValid, errorMessage) = (request ?? new BootstrapGroupBotsRequest()).Validate();
        if (!isValid)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, errorMessage!));
        }

        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        groupId = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(groupId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "groupId 不能为空"));
        }

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        // 仅群主/管理员可初始化（避免普通成员把机器人“塞进群”）
        var actor = await _userService.GetByIdAsync(userId);
        if (actor == null)
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }
        if (actor.Role != UserRole.ADMIN && group.OwnerId != userId)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅群主可初始化机器人"));
        }

        if (request is { DryRun: true })
        {
            // 预留：当前不支持 dry-run（避免与“幂等初始化”语义混淆）
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "dryRun 暂不支持"));
        }

        IReadOnlyList<User> bots;
        try
        {
            bots = await _groupBotService.EnsureDefaultRoleBotsInGroupAsync(groupId);
        }
        catch (ArgumentException ex) when (ex.Message.Contains("群组不存在", StringComparison.Ordinal))
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        var members = await _groupService.GetMembersAsync(groupId);
        var botSet = bots.Select(x => x.UserId).ToHashSet(StringComparer.Ordinal);
        var botMembers = members.Where(m => botSet.Contains(m.UserId)).ToList();

        var response = new BootstrapGroupBotsResponse
        {
            GroupId = groupId,
            Bots = botMembers.Select(m =>
            {
                var u = bots.First(x => x.UserId == m.UserId);
                var tags = m.Tags ?? new List<GroupMemberTag>();
                if (tags.Count == 0)
                {
                    tags = BuildDefaultBotTags(u.BotKind ?? BotKind.DEV);
                }
                return new GroupMemberResponse
                {
                    UserId = u.UserId,
                    Username = u.Username,
                    DisplayName = u.DisplayName,
                    MemberRole = m.MemberRole,
                    IsBot = true,
                    BotKind = u.BotKind,
                    AvatarFileName = u.AvatarFileName,
                    AvatarUrl = BuildAvatarUrl(u),
                    Tags = tags.Select(t => new GroupMemberTagDto { Name = t.Name, Role = t.Role }).ToList(),
                    JoinedAt = m.JoinedAt,
                    IsOwner = false
                };
            }).ToList()
        };

        return Ok(ApiResponse<BootstrapGroupBotsResponse>.Ok(response));
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

        // PRD 变更：必须让所有成员重新建立 group->session 映射，否则桌面端会继续复用旧 sessionId，导致“串 PRD/串上下文”。
        // - group session 映射 key：group:session:{groupId}:{userId}
        // - LLM 上下文缓存 key：chat:history:group:{groupId}
        try
        {
            await _cache.RemoveByPatternAsync($"group:session:{groupId}:*");
            await _cache.RemoveAsync(CacheKeys.ForGroupChatHistory(groupId));
        }
        catch
        {
            // cache 失效失败不应影响主流程；最坏情况是等 TTL 到期
        }

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

        // PRD 解绑同样需要失效 group session 映射与上下文缓存
        try
        {
            await _cache.RemoveByPatternAsync($"group:session:{groupId}:*");
            await _cache.RemoveAsync(CacheKeys.ForGroupChatHistory(groupId));
        }
        catch
        {
            // ignore
        }

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
    /// 获取群组消息历史（分页，按 GroupSeq 升序返回）
    /// </summary>
    /// <param name="groupId">群组ID</param>
    /// <param name="limit">返回条数（默认50，最大200）</param>
    /// <param name="before">可选：仅返回 Timestamp &lt; before 的更早消息（兼容旧客户端）</param>
    /// <param name="afterSeq">可选：仅返回 GroupSeq &gt; afterSeq 的消息（增量同步）</param>
    /// <param name="beforeSeq">可选：仅返回 GroupSeq &lt; beforeSeq 的消息（历史分页）</param>
    [HttpGet("{groupId}/messages")]
    [ProducesResponseType(typeof(ApiResponse<List<MessageResponse>>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetGroupMessages(
        string groupId,
        [FromQuery] int limit = 50,
        [FromQuery] DateTime? before = null,
        [FromQuery] long? afterSeq = null,
        [FromQuery] long? beforeSeq = null)
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

        // 优先级：afterSeq > beforeSeq > before（timestamp）
        // - afterSeq：增量同步（拉取新消息）
        // - beforeSeq：历史分页（向前加载）
        // - before：兼容旧客户端
        List<Message> messages;
        if (afterSeq.HasValue && afterSeq.Value > 0)
        {
            messages = await _messageRepository.FindByGroupAfterSeqAsync(groupId, afterSeq.Value, limit);
        }
        else if (beforeSeq.HasValue && beforeSeq.Value > 0)
        {
            messages = await _messageRepository.FindByGroupBeforeSeqAsync(groupId, beforeSeq.Value, limit);
        }
        else
        {
            messages = await _messageRepository.FindByGroupAsync(groupId, before, limit);
        }

        // 批量补齐 sender 信息（包括用户和机器人，避免 N+1）
        var senderIds = messages
            .Select(m => m.SenderId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct()
            .ToList();
        var senderInfoMap = new Dictionary<string, (string Name, UserRole Role, string? AvatarFileName, List<GroupMemberTag>? Tags)>(StringComparer.Ordinal);
        if (senderIds.Count > 0)
        {
            var users = await _db.Users
                .Find(u => senderIds.Contains(u.UserId))
                .ToListAsync();
            foreach (var u in users)
            {
                var uid = u.UserId;
                if (string.IsNullOrWhiteSpace(uid)) continue;
                var name = (u.DisplayName ?? u.Username ?? uid).Trim();
                var avatarFileName = u.AvatarFileName;
                
                // 获取该用户在当前群组的 tags（机器人会有"机器人"标签）
                var member = members.FirstOrDefault(m => m.UserId == uid);
                var tags = member?.Tags;
                
                senderInfoMap[uid!] = (name, u.Role, avatarFileName, tags);
            }
        }

        // 统计 Assistant 消息数量（用于日志）
        var assistantCount = messages.Count(m => m.Role == MessageRole.Assistant && !string.IsNullOrWhiteSpace(m.SenderId));
        _logger.LogInformation(
            "GetGroupMessages: groupId={GroupId}, limit={Limit}, messagesCount={Count}, assistantCount={AssistantCount}",
            groupId, limit, messages.Count, assistantCount);

        var result = messages.Select(m =>
        {
            // 补齐 sender 信息（统一处理用户和机器人）
            string? senderName = null;
            UserRole? senderRole = null;
            string? senderAvatarUrl = null;
            List<GroupMemberTag>? senderTags = null;
            
            if (!string.IsNullOrWhiteSpace(m.SenderId) && senderInfoMap.TryGetValue(m.SenderId, out var info))
            {
                senderName = info.Name;
                senderRole = info.Role;
                senderAvatarUrl = AvatarUrlBuilder.Build(_cfg, info.AvatarFileName);
                senderTags = info.Tags;
            }

            return new MessageResponse
        {
            Id = m.Id,
            GroupSeq = m.GroupSeq,
            SenderId = m.SenderId,
                SenderName = senderName,
                SenderRole = senderRole,
                SenderAvatarUrl = senderAvatarUrl,
                SenderTags = senderTags,
            Role = m.Role,
            Content = m.Content,
            ThinkingContent = m.ThinkingContent,
            ReplyToMessageId = m.ReplyToMessageId,
            ResendOfMessageId = m.ResendOfMessageId,
            ViewRole = m.ViewRole,
            Timestamp = m.Timestamp,
                TokenUsage = m.TokenUsage
            };
        }).ToList();

        // 打印前3条 Assistant 消息的 ID 用于调试
        foreach (var msg in result.Take(3).Where(m => m.Role == MessageRole.Assistant))
        {
            _logger.LogInformation(
                "Assistant Message: id={Id}, senderId={SenderId}, avatarUrl={AvatarUrl}",
                msg.Id, msg.SenderId ?? "null", msg.SenderAvatarUrl ?? "null");
        }

        return Ok(ApiResponse<List<MessageResponse>>.Ok(result));
    }

    /// <summary>
    /// 清理群组上下文（仅清理服务端 LLM 上下文缓存，不删除消息历史）
    /// </summary>
    /// <remarks>
    /// 用途：用户主动“清理上下文”后，下一次提问不应携带历史对话进入 LLM 上下文拼接。
    /// 注意：消息历史仍保留在 MongoDB（用于回放/审计/后台排障）。
    /// </remarks>
    [HttpPost("{groupId}/context/clear")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> ClearGroupContext(string groupId)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        groupId = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(groupId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "groupId 不能为空"));
        }

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.GROUP_NOT_FOUND, "群组不存在"));
        }

        var isMember = await _groupService.IsMemberAsync(groupId, userId);
        if (!isMember)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "您不是该群组成员"));
        }

        // 关键：仅删除 chat history cache 并不足以“重置上下文”，因为 ChatService 会在 cache miss 时回源 Mongo 并回填。
        // 因此这里写入一个 reset marker：后端在拼接 LLM 上下文时只取 reset 之后的消息。
        var resetAtUtc = DateTime.UtcNow;
        await _cache.SetAsync(CacheKeys.ForGroupContextReset(groupId), resetAtUtc.Ticks, expiry: TimeSpan.FromDays(30));
        await _cache.RemoveAsync(CacheKeys.ForGroupChatHistory(groupId));
        _logger.LogInformation("Group context cleared: groupId={GroupId}, userId={UserId}", groupId, userId);
        return Ok(ApiResponse<object>.Ok(new object()));
    }

    /// <summary>
    /// 订阅群消息事件（SSE）：支持 afterSeq / Last-Event-ID 断线续传
    /// </summary>
    [HttpGet("{groupId}/messages/stream")]
    [Produces("text/event-stream")]
    public async Task GroupMessagesStream(
        string groupId,
        [FromQuery] long afterSeq = 0,
        CancellationToken cancellationToken = default)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            await WriteSseAsync(
                id: null,
                eventName: "message",
                dataJson: JsonSerializer.Serialize(new StreamErrorEvent { Type = "error", ErrorCode = ErrorCodes.UNAUTHORIZED, ErrorMessage = "未授权" }, AppJsonContext.Default.StreamErrorEvent),
                ct: cancellationToken);
            return;
        }

        groupId = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(groupId))
        {
            await WriteSseAsync(
                id: null,
                eventName: "message",
                dataJson: JsonSerializer.Serialize(new StreamErrorEvent { Type = "error", ErrorCode = ErrorCodes.INVALID_FORMAT, ErrorMessage = "groupId 不能为空" }, AppJsonContext.Default.StreamErrorEvent),
                ct: cancellationToken);
            return;
        }

        // 兼容 EventSource 的 Last-Event-ID（未传 afterSeq 时才读）
        if (afterSeq <= 0)
        {
            var last = (Request.Headers["Last-Event-ID"].FirstOrDefault() ?? string.Empty).Trim();
            if (long.TryParse(last, out var parsed) && parsed > 0) afterSeq = parsed;
        }

        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null)
        {
            await WriteSseAsync(
                id: null,
                eventName: "message",
                dataJson: JsonSerializer.Serialize(new StreamErrorEvent { Type = "error", ErrorCode = ErrorCodes.GROUP_NOT_FOUND, ErrorMessage = "群组不存在" }, AppJsonContext.Default.StreamErrorEvent),
                ct: cancellationToken);
            return;
        }

        var isMember = await _groupService.IsMemberAsync(groupId, userId);
        if (!isMember)
        {
            await WriteSseAsync(
                id: null,
                eventName: "message",
                dataJson: JsonSerializer.Serialize(new StreamErrorEvent { Type = "error", ErrorCode = ErrorCodes.PERMISSION_DENIED, ErrorMessage = "您不是该群组成员" }, AppJsonContext.Default.StreamErrorEvent),
                ct: cancellationToken);
            return;
        }

        // 1) 回放 Mongo：按 groupSeq 递增（仅回放用户态可见消息，过滤已删除）
        while (!cancellationToken.IsCancellationRequested)
        {
            var batch = await _db.Messages
                .Find(x => x.GroupId == groupId && x.GroupSeq != null && x.GroupSeq > afterSeq && x.IsDeleted != true)
                .SortBy(x => x.GroupSeq)
                .Limit(200)
                .ToListAsync(cancellationToken);

            if (batch.Count == 0) break;

            // 本批次 sender 信息预取（包括头像）
            var batchSenderIds = batch
                .Select(x => x.SenderId)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Distinct()
                .ToList();
            var batchSenderInfoMap = new Dictionary<string, (string Name, UserRole Role, string? AvatarUrl, List<GroupMemberTag>? Tags)>(StringComparer.Ordinal);
            if (batchSenderIds.Count > 0)
            {
                var users = await _db.Users
                    .Find(u => batchSenderIds.Contains(u.UserId))
                    .ToListAsync(cancellationToken);
                
                // 获取群成员信息（用于 tags）
                var batchMembers = await _groupService.GetMembersAsync(groupId);
                
                foreach (var u in users)
                {
                    var uid = u.UserId;
                    if (string.IsNullOrWhiteSpace(uid)) continue;
                    var name = (u.DisplayName ?? u.Username ?? uid).Trim();
                    var avatarUrl = AvatarUrlBuilder.Build(_cfg, u.AvatarFileName);
                    var member = batchMembers.FirstOrDefault(m => m.UserId == uid);
                    var tags = member?.Tags;
                    batchSenderInfoMap[uid!] = (name, u.Role, avatarUrl, tags);
                }
            }

            foreach (var m in batch)
            {
                if (!m.GroupSeq.HasValue) continue;
                var seq = m.GroupSeq.Value;
                string? senderName = null;
                UserRole? senderRole = null;
                string? senderAvatarUrl = null;
                List<GroupMemberTag>? senderTags = null;
                
                if (m.SenderId != null && batchSenderInfoMap.TryGetValue(m.SenderId, out var info))
                {
                    senderName = info.Name;
                    senderRole = info.Role;
                    senderAvatarUrl = info.AvatarUrl;
                    senderTags = info.Tags;
                }
                
                var payload = ToStreamEvent(m, "message", senderName, senderRole, senderAvatarUrl, senderTags);
                var json = JsonSerializer.Serialize(payload, AppJsonContext.Default.GroupMessageStreamEventDto);
                await WriteSseAsync(id: seq.ToString(), eventName: "message", dataJson: json, ct: cancellationToken);
                afterSeq = seq;
            }
        }

        // 2) 实时订阅：进程内广播（断线续传靠上面的 Mongo 回放）
        using var sub = _groupMessageStreamHub.Subscribe(groupId);
        var reader = sub.Reader;
        var lastKeepAliveAt = DateTime.UtcNow;
        var senderInfoCache = new Dictionary<string, (string Name, UserRole Role, string? AvatarUrl, List<GroupMemberTag>? Tags)>(StringComparer.Ordinal);
        var groupMembersCache = await _groupService.GetMembersAsync(groupId);

        async Task<(string? Name, UserRole? Role, string? AvatarUrl, List<GroupMemberTag>? Tags)> ResolveSenderInfoAsync(string? senderId)
        {
            if (string.IsNullOrWhiteSpace(senderId)) return (null, null, null, null);
            if (senderInfoCache.TryGetValue(senderId, out var cached)) 
                return (cached.Name, cached.Role, cached.AvatarUrl, cached.Tags);
            
            var u = await _db.Users
                .Find(x => x.UserId == senderId)
                .FirstOrDefaultAsync(cancellationToken);
            if (u == null) return (null, null, null, null);
            
            var name = (u.DisplayName ?? u.Username ?? u.UserId ?? string.Empty).Trim();
            var avatarUrl = AvatarUrlBuilder.Build(_cfg, u.AvatarFileName);
            var member = groupMembersCache.FirstOrDefault(m => m.UserId == senderId);
            var tags = member?.Tags;
            
            senderInfoCache[senderId] = (name, u.Role, avatarUrl, tags);
            return (name, u.Role, avatarUrl, tags);
        }

        while (!cancellationToken.IsCancellationRequested)
        {
            // keepalive：避免代理/客户端超时关闭
            if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 10)
            {
                await Response.WriteAsync(": keepalive\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);
                lastKeepAliveAt = DateTime.UtcNow;
            }

            // 等待一会儿（短轮询），让 keepalive 有机会写出；同时避免 WaitToReadAsync 一直阻塞导致 keepalive 缺失
            var waitTask = reader.WaitToReadAsync(cancellationToken).AsTask();
            var tick = Task.Delay(650, cancellationToken);
            var done = await Task.WhenAny(waitTask, tick);
            if (done != waitTask) continue;
            if (!await waitTask) break;

            while (reader.TryRead(out var ev))
            {
                // delta：AI 流式输出的增量内容（不参与 seq 排序，直接推送）
                if (string.Equals(ev.Type, "delta", StringComparison.OrdinalIgnoreCase))
                {
                    var deltaEvent = new GroupMessageStreamEventDto
                    {
                        Type = "delta",
                        MessageId = ev.MessageId,
                        DeltaContent = ev.DeltaContent,
                        BlockId = ev.BlockId,
                        IsFirstChunk = ev.IsFirstChunk
                    };
                    var json = JsonSerializer.Serialize(deltaEvent, AppJsonContext.Default.GroupMessageStreamEventDto);
                    await WriteSseAsync(id: null, eventName: "message", dataJson: json, ct: cancellationToken);
                    lastKeepAliveAt = DateTime.UtcNow;
                    continue;
                }

                // thinking：AI 思考过程的增量内容（不参与 seq 排序，直接推送）
                if (string.Equals(ev.Type, "thinking", StringComparison.OrdinalIgnoreCase))
                {
                    var thinkingEvent = new GroupMessageStreamEventDto
                    {
                        Type = "thinking",
                        MessageId = ev.MessageId,
                        ThinkingContent = ev.ThinkingContent
                    };
                    var json = JsonSerializer.Serialize(thinkingEvent, AppJsonContext.Default.GroupMessageStreamEventDto);
                    _logger.LogInformation("[GroupsController] ✦ SSE thinking: messageId={MessageId}, contentLen={Len}, json={Json}",
                        ev.MessageId, ev.ThinkingContent?.Length ?? 0, json.Length > 200 ? json[..200] + "..." : json);
                    await WriteSseAsync(id: null, eventName: "message", dataJson: json, ct: cancellationToken);
                    lastKeepAliveAt = DateTime.UtcNow;
                    continue;
                }

                // blockEnd：Block 结束事件（不参与 seq 排序，直接推送）
                if (string.Equals(ev.Type, "blockEnd", StringComparison.OrdinalIgnoreCase))
                {
                    var blockEndEvent = new GroupMessageStreamEventDto
                    {
                        Type = "blockEnd",
                        MessageId = ev.MessageId,
                        BlockId = ev.BlockId
                    };
                    var json = JsonSerializer.Serialize(blockEndEvent, AppJsonContext.Default.GroupMessageStreamEventDto);
                    await WriteSseAsync(id: null, eventName: "message", dataJson: json, ct: cancellationToken);
                    lastKeepAliveAt = DateTime.UtcNow;
                    continue;
                }

                // citations：引用/注脚事件（不参与 seq 排序，直接推送）
                if (string.Equals(ev.Type, "citations", StringComparison.OrdinalIgnoreCase) && ev.Citations != null && ev.Citations.Count > 0)
                {
                    var citationsEvent = new GroupMessageStreamEventDto
                    {
                        Type = "citations",
                        MessageId = ev.MessageId,
                        Citations = ev.Citations.Select(c => new DocCitationDto
                        {
                            HeadingTitle = c.HeadingTitle,
                            HeadingId = c.HeadingId,
                            Excerpt = c.Excerpt,
                            Score = c.Score,
                            Rank = c.Rank
                        }).ToList()
                    };
                    var json = JsonSerializer.Serialize(citationsEvent, AppJsonContext.Default.GroupMessageStreamEventDto);
                    await WriteSseAsync(id: null, eventName: "message", dataJson: json, ct: cancellationToken);
                    lastKeepAliveAt = DateTime.UtcNow;
                    continue;
                }

                // messageUpdated：用于在线通知（例如软删除），不依赖 afterSeq 递增
                if (string.Equals(ev.Type, "messageUpdated", StringComparison.OrdinalIgnoreCase))
                {
                    var info = await ResolveSenderInfoAsync(ev.Message!.SenderId);
                    var json = JsonSerializer.Serialize(ToStreamEvent(ev.Message!, "messageUpdated", info.Name, info.Role, info.AvatarUrl, info.Tags), AppJsonContext.Default.GroupMessageStreamEventDto);
                    await WriteSseAsync(id: ev.Seq.ToString(), eventName: "message", dataJson: json, ct: cancellationToken);
                    lastKeepAliveAt = DateTime.UtcNow;
                    continue;
                }

                // message：严格按 afterSeq 去重/推进
                if (ev.Seq <= afterSeq) continue;
                // Fast path: 占位消息（空内容）跳过 DB 查询，减少 thinking 事件的竞争窗口
                var isPlaceholder = ev.Message != null && string.IsNullOrEmpty(ev.Message.Content);
                (string? Name, UserRole? Role, string? AvatarUrl, List<GroupMemberTag>? Tags) info2;
                if (isPlaceholder)
                {
                    info2 = (null, null, null, null);
                }
                else
                {
                    info2 = await ResolveSenderInfoAsync(ev.Message!.SenderId);
                }
                var json2 = JsonSerializer.Serialize(ToStreamEvent(ev.Message!, "message", info2.Name, info2.Role, info2.AvatarUrl, info2.Tags), AppJsonContext.Default.GroupMessageStreamEventDto);
                await WriteSseAsync(id: ev.Seq.ToString(), eventName: "message", dataJson: json2, ct: cancellationToken);
                afterSeq = ev.Seq;
                lastKeepAliveAt = DateTime.UtcNow;
            }
        }
    }

    private static GroupMessageStreamEventDto ToStreamEvent(
        Message m, 
        string type, 
        string? senderName, 
        UserRole? senderRole,
        string? senderAvatarUrl = null,
        List<GroupMemberTag>? senderTags = null)
    {
        var isUpdate = string.Equals(type, "messageUpdated", StringComparison.OrdinalIgnoreCase);
        var shouldHideContent = isUpdate || m.IsDeleted;
        return new GroupMessageStreamEventDto
        {
            Type = type,
            Message = new GroupMessageStreamMessageDto
            {
                Id = m.Id,
                GroupId = m.GroupId,
                GroupSeq = m.GroupSeq ?? 0,
                IsDeleted = m.IsDeleted,
                SessionId = m.SessionId,
                RunId = m.RunId,
                SenderId = m.SenderId,
                SenderName = senderName,
                SenderRole = senderRole,
                SenderAvatarUrl = senderAvatarUrl,
                SenderTags = senderTags,
                Role = m.Role,
                Content = shouldHideContent ? string.Empty : m.Content,
                ThinkingContent = shouldHideContent ? null : m.ThinkingContent,
                ReplyToMessageId = m.ReplyToMessageId,
                ResendOfMessageId = m.ResendOfMessageId,
                ViewRole = m.ViewRole,
                Timestamp = m.Timestamp,
                TokenUsage = m.TokenUsage
            }
        };
    }

    private static List<GroupMemberTag> BuildDefaultHumanTags(UserRole role)
    {
        return new List<GroupMemberTag>
        {
            new()
            {
                Name = role switch
                {
                    UserRole.PM => "产品经理",
                    UserRole.DEV => "开发",
                    UserRole.QA => "测试",
                    UserRole.ADMIN => "管理员",
                    _ => "成员"
                },
                Role = role switch
                {
                    UserRole.PM => "pm",
                    UserRole.DEV => "dev",
                    UserRole.QA => "qa",
                    UserRole.ADMIN => "admin",
                    _ => "member"
                }
            }
        };
    }

    private static List<GroupMemberTag> BuildDefaultBotTags(BotKind kind)
    {
        var roleTag = kind switch
        {
            BotKind.PM => new GroupMemberTag { Name = "产品经理", Role = "pm" },
            BotKind.DEV => new GroupMemberTag { Name = "开发", Role = "dev" },
            BotKind.QA => new GroupMemberTag { Name = "测试", Role = "qa" },
            _ => new GroupMemberTag { Name = "开发", Role = "dev" }
        };

        return new List<GroupMemberTag>
        {
            new() { Name = "机器人", Role = "robot" },
            roleTag
        };
    }

    /// <summary>
    /// 更新群组名称
    /// </summary>
    [HttpPatch("{groupId}/name")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> UpdateGroupName(string groupId, [FromBody] UpdateGroupNameRequest request)
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

        // 只有群主可以修改群名
        if (group.OwnerId != userId)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅群主可修改群组名称"));
        }

        await _groupService.UpdateGroupNameAsync(groupId, request.GroupName!);

        _logger.LogInformation("Group name updated: {GroupId} -> {GroupName}", groupId, request.GroupName);

        return Ok(ApiResponse<object?>.Ok(null));
    }

    private async Task WriteSseAsync(string? id, string eventName, string dataJson, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(id))
        {
            await Response.WriteAsync($"id: {id}\n", ct);
        }
        await Response.WriteAsync($"event: {eventName}\n", ct);
        await Response.WriteAsync($"data: {dataJson}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }
}
