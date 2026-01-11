using System.Text.Json;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Json;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 消息控制器（SSE流式响应）
/// </summary>
[ApiController]
[Route("api/v1/sessions/{sessionId}/messages")]
[Authorize]
public class MessagesController : ControllerBase
{
    private readonly IChatService _chatService;
    private readonly IMessageRepository _messageRepository;
    private readonly ICacheManager _cache;
    private readonly IGroupMessageStreamHub _groupMessageStreamHub;
    private readonly ISessionService _sessionService;
    private readonly IConfiguration _configuration;
    private readonly ILogger<MessagesController> _logger;
    private readonly MongoDbContext _db;

    public MessagesController(
        IChatService chatService,
        IMessageRepository messageRepository,
        ICacheManager cache,
        IGroupMessageStreamHub groupMessageStreamHub,
        ISessionService sessionService,
        IConfiguration configuration,
        MongoDbContext db,
        ILogger<MessagesController> logger)
    {
        _chatService = chatService;
        _messageRepository = messageRepository;
        _cache = cache;
        _groupMessageStreamHub = groupMessageStreamHub;
        _sessionService = sessionService;
        _configuration = configuration;
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// 发送消息（SSE流式响应）
    /// </summary>
    [HttpPost]
    [Produces("text/event-stream")]
    public async Task SendMessage(
        string sessionId,
        [FromBody] SendMessageRequest request,
        CancellationToken cancellationToken)
    {
        // 验证请求参数
        var (isValid, errorMessage) = request.Validate();
        if (!isValid)
        {
            Response.ContentType = "text/event-stream";
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.INVALID_FORMAT,
                ErrorMessage = errorMessage!
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);
            await Response.WriteAsync($"event: error\ndata: {errorData}\n\n", cancellationToken);
            return;
        }

        // 设置SSE响应头
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        // 获取用户ID（已认证）
        var userId = User.FindFirst("sub")?.Value ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrWhiteSpace(userId))
        {
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.UNAUTHORIZED,
                ErrorMessage = "未授权"
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);
            await Response.WriteAsync($"event: error\ndata: {errorData}\n\n", cancellationToken);
            return;
        }

        // 计算本次回答机器人角色：
        // - 群会话：按成员身份（GroupMember.MemberRole）
        // - 个人会话：仅 ADMIN 可用 request.Role 覆盖（用于“选择回答机器人”）
        UserRole? answerAsRole = null;
        try
        {
            var sid = (sessionId ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(sid))
            {
                var session = await _sessionService.GetByIdAsync(sid);
                if (session != null)
                {
                    var gid = (session.GroupId ?? string.Empty).Trim();
                    if (!string.IsNullOrWhiteSpace(gid))
                    {
                        var member = await _db.GroupMembers
                            .Find(x => x.GroupId == gid && x.UserId == userId)
                            .FirstOrDefaultAsync(cancellationToken);
                        if (member == null)
                        {
                            var err = new StreamErrorEvent
                            {
                                Type = "error",
                                ErrorCode = ErrorCodes.PERMISSION_DENIED,
                                ErrorMessage = "您不是该群组成员"
                            };
                            var errData = JsonSerializer.Serialize(err, AppJsonContext.Default.StreamErrorEvent);
                            await Response.WriteAsync($"event: error\ndata: {errData}\n\n", cancellationToken);
                            return;
                        }

                        answerAsRole = member.MemberRole;
                    }
                    else if (request.Role.HasValue)
                    {
                        var u = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(cancellationToken);
                        if (u?.Role == UserRole.ADMIN)
                        {
                            answerAsRole = request.Role.Value;
                        }
                    }
                }
            }
        }
        catch
        {
            // ignore：不因为“角色计算失败”中断对话；交由 ChatService 使用 session.CurrentRole 兜底
        }

        try
        {
            await foreach (var streamEvent in _chatService.SendMessageAsync(
                sessionId,
                request.Content,
                resendOfMessageId: null,
                promptKey: request.PromptKey,
                userId: userId,
                attachmentIds: request.AttachmentIds,
                answerAsRole: answerAsRole,
                cancellationToken: cancellationToken))
            {
                var eventData = JsonSerializer.Serialize(streamEvent, AppJsonContext.Default.ChatStreamEvent);

                await Response.WriteAsync($"event: message\n", cancellationToken);
                await Response.WriteAsync($"data: {eventData}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);

                // 如果是错误或完成，结束流
                if (streamEvent.Type is "error" or "done")
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            _logger.LogInformation("SSE connection cancelled for session {SessionId}", sessionId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in SSE stream for session {SessionId}", sessionId);
            
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.INTERNAL_ERROR,
                ErrorMessage = "服务器内部错误"
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);

            await Response.WriteAsync($"event: error\n", cancellationToken);
            await Response.WriteAsync($"data: {errorData}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);
        }
    }

    /// <summary>
    /// 重发历史用户消息（软删除旧轮次，并以新内容重新发起一次对话，SSE流式响应）
    /// 说明：
    /// - 仅允许消息发送者重发自己的 User 消息
    /// - 旧轮次（旧User + 其 Assistant 回复）对用户态完全不可见，但保留在 DB 供后台排障
    /// </summary>
    [HttpPost("{messageId}/resend")]
    [Produces("text/event-stream")]
    public async Task ResendMessage(
        string sessionId,
        string messageId,
        [FromBody] SendMessageRequest request,
        CancellationToken cancellationToken)
    {
        // 验证请求参数
        var (isValid, errorMessage) = request.Validate();
        if (!isValid)
        {
            Response.ContentType = "text/event-stream";
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.INVALID_FORMAT,
                ErrorMessage = errorMessage!
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);
            await Response.WriteAsync($"event: error\ndata: {errorData}\n\n", cancellationToken);
            return;
        }

        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = User.FindFirst("sub")?.Value ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrWhiteSpace(userId))
        {
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.UNAUTHORIZED,
                ErrorMessage = "未授权"
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);
            await Response.WriteAsync($"event: error\ndata: {errorData}\n\n", cancellationToken);
            return;
        }

        var oldId = (messageId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(oldId))
        {
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.INVALID_FORMAT,
                ErrorMessage = "messageId 不能为空"
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);
            await Response.WriteAsync($"event: error\ndata: {errorData}\n\n", cancellationToken);
            return;
        }

        // 读取旧消息（必须是当前用户的 User 消息，且未删除）
        var old = await _messageRepository.FindByIdAsync(oldId, includeDeleted: true);
        if (old == null || old.IsDeleted)
        {
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.SESSION_NOT_FOUND,
                ErrorMessage = "目标消息不存在或已删除"
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);
            await Response.WriteAsync($"event: error\ndata: {errorData}\n\n", cancellationToken);
            return;
        }

        if (old.Role != MessageRole.User)
        {
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.INVALID_FORMAT,
                ErrorMessage = "仅支持重发用户消息"
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);
            await Response.WriteAsync($"event: error\ndata: {errorData}\n\n", cancellationToken);
            return;
        }

        if (!string.Equals((old.SenderId ?? string.Empty).Trim(), userId.Trim(), StringComparison.Ordinal))
        {
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.PERMISSION_DENIED,
                ErrorMessage = "仅允许重发自己发送的消息"
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);
            await Response.WriteAsync($"event: error\ndata: {errorData}\n\n", cancellationToken);
            return;
        }

        var gid = (old.GroupId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid))
        {
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.INVALID_FORMAT,
                ErrorMessage = "目标消息不属于群组会话"
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);
            await Response.WriteAsync($"event: error\ndata: {errorData}\n\n", cancellationToken);
            return;
        }

        // 群会话重发：按成员身份决定回答机器人；仅 ADMIN 可用 request.Role 覆盖
        UserRole? answerAsRole = null;
        try
        {
            var member = await _db.GroupMembers
                .Find(x => x.GroupId == gid && x.UserId == userId)
                .FirstOrDefaultAsync(cancellationToken);
            if (member != null)
            {
                answerAsRole = member.MemberRole;
            }
            if (request.Role.HasValue)
            {
                var u = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(cancellationToken);
                if (u?.Role == UserRole.ADMIN)
                {
                    answerAsRole = request.Role.Value;
                }
            }
        }
        catch
        {
            // ignore：交由 ChatService 用 session.CurrentRole 兜底
        }

        var deletedAtUtc = DateTime.UtcNow;

        // 1) 软删除旧轮次：旧 user + 其 assistant 回复
        var deleted = await _messageRepository.SoftDeleteAsync(old.Id, userId, reason: "resend", deletedAtUtc: deletedAtUtc);
        if (deleted != null) _groupMessageStreamHub.PublishUpdated(deleted);

        var replies = await _messageRepository.FindByReplyToMessageIdAsync(old.Id, includeDeleted: true);
        foreach (var r in replies)
        {
            if (r == null || r.IsDeleted) continue;
            var dd = await _messageRepository.SoftDeleteAsync(r.Id, userId, reason: "resend", deletedAtUtc: deletedAtUtc);
            if (dd != null) _groupMessageStreamHub.PublishUpdated(dd);
        }

        // 2) 清理群对话缓存：避免被删轮次继续进入 LLM 上下文
        await _cache.RemoveAsync(CacheKeys.ForGroupChatHistory(gid));

        // 3) 发起一次新的 LLM 对话（新消息会按现有逻辑写入 Mongo + 群广播）
        try
        {
            await foreach (var streamEvent in _chatService.SendMessageAsync(
                sessionId,
                request.Content,
                resendOfMessageId: old.Id,
                promptKey: request.PromptKey,
                userId: userId,
                attachmentIds: request.AttachmentIds,
                answerAsRole: answerAsRole,
                cancellationToken: cancellationToken))
            {
                var eventData = JsonSerializer.Serialize(streamEvent, AppJsonContext.Default.ChatStreamEvent);

                await Response.WriteAsync($"event: message\n", cancellationToken);
                await Response.WriteAsync($"data: {eventData}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);

                if (streamEvent.Type is "error" or "done")
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            _logger.LogInformation("Resend SSE connection cancelled for session {SessionId}", sessionId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in resend SSE stream for session {SessionId}", sessionId);
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.INTERNAL_ERROR,
                ErrorMessage = "服务器内部错误"
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);
            await Response.WriteAsync($"event: error\n", cancellationToken);
            await Response.WriteAsync($"data: {errorData}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);
        }
    }

    /// <summary>
    /// 获取消息历史
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<List<MessageResponse>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetHistory(
        string sessionId,
        [FromQuery] int limit = 50,
        [FromQuery] DateTime? before = null)
    {
        // 历史回放：走 MongoDB 分页（持久化），而不是 cache（cache 仅用于 LLM 上下文拼接）
        var messages = await _messageRepository.FindBySessionAsync(sessionId, before, limit);

        // 批量补齐 sender 信息（统一处理用户和机器人）
        var senderIds = messages
            .Select(m => m.SenderId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct()
            .ToList();
        var senderInfoMap = new Dictionary<string, (string Name, UserRole Role, string? AvatarUrl, List<GroupMemberTag>? Tags)>(StringComparer.Ordinal);
        if (senderIds.Count > 0)
        {
            var users = await _db.Users
                .Find(u => senderIds.Contains(u.UserId))
                .ToListAsync();
            
            // 获取群成员信息（用于 tags）
            var session = await _sessionService.GetByIdAsync(sessionId);
            List<GroupMember> members = new();
            if (!string.IsNullOrWhiteSpace(session?.GroupId))
            {
                members = await _db.GroupMembers
                    .Find(gm => gm.GroupId == session.GroupId && senderIds.Contains(gm.UserId))
                    .ToListAsync();
            }
            
            foreach (var u in users)
            {
                var uid = u.UserId;
                if (string.IsNullOrWhiteSpace(uid)) continue;
                var name = (u.DisplayName ?? u.Username ?? uid).Trim();
                var avatarUrl = AvatarUrlBuilder.Build(_configuration, u.AvatarFileName);
                var member = members.FirstOrDefault(m => m.UserId == uid);
                var tags = member?.Tags;
                senderInfoMap[uid!] = (name, u.Role, avatarUrl, tags);
            }
        }
        
        var response = messages.Select(m =>
        {
            string? senderName = null;
            UserRole? senderRole = null;
            string? senderAvatarUrl = null;
            List<GroupMemberTag>? senderTags = null;
            
            if (!string.IsNullOrWhiteSpace(m.SenderId) && senderInfoMap.TryGetValue(m.SenderId, out var info))
            {
                senderName = info.Name;
                senderRole = info.Role;
                senderAvatarUrl = info.AvatarUrl;
                senderTags = info.Tags;
            }
            
            return new MessageResponse
            {
                Id = m.Id,
                GroupSeq = m.GroupSeq,
                RunId = m.RunId,
                SenderId = m.SenderId,
                SenderName = senderName,
                SenderRole = senderRole,
                SenderAvatarUrl = senderAvatarUrl,
                SenderTags = senderTags,
                Role = m.Role,
                Content = m.Content,
                ReplyToMessageId = m.ReplyToMessageId,
                ResendOfMessageId = m.ResendOfMessageId,
                ViewRole = m.ViewRole,
                Timestamp = m.Timestamp,
                TokenUsage = m.TokenUsage
            };
        }).ToList();

        return Ok(ApiResponse<List<MessageResponse>>.Ok(response));
    }
}

/// <summary>
/// 消息响应
/// </summary>
public class MessageResponse
{
    public string Id { get; set; } = string.Empty;
    public long? GroupSeq { get; set; }
    public string? RunId { get; set; }
    public string? SenderId { get; set; }
    public string? SenderName { get; set; }
    public UserRole? SenderRole { get; set; }
    public string? SenderAvatarUrl { get; set; }
    public List<GroupMemberTag>? SenderTags { get; set; }
    public MessageRole Role { get; set; }
    public string Content { get; set; } = string.Empty;
    public string? ReplyToMessageId { get; set; }
    public string? ResendOfMessageId { get; set; }
    public UserRole? ViewRole { get; set; }
    public DateTime Timestamp { get; set; }
    public TokenUsage? TokenUsage { get; set; }
}




