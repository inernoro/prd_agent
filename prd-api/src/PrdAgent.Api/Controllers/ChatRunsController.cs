using System.Text.Json;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Json;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 对话 Run：服务端闭环执行；客户端仅观察（支持断线恢复）。
/// </summary>
[ApiController]
[Route("api/v1")]
[Authorize]
public class ChatRunsController : ControllerBase
{
    private readonly ISessionService _sessionService;
    private readonly IMessageRepository _messageRepository;
    private readonly IGroupMessageSeqService _groupMessageSeqService;
    private readonly IGroupMessageStreamHub _groupMessageStreamHub;
    private readonly IRunEventStore _runStore;
    private readonly IRunQueue _runQueue;
    private readonly MongoDbContext _db;
    private readonly ILogger<ChatRunsController> _logger;

    public ChatRunsController(
        ISessionService sessionService,
        IMessageRepository messageRepository,
        IGroupMessageSeqService groupMessageSeqService,
        IGroupMessageStreamHub groupMessageStreamHub,
        IRunEventStore runStore,
        IRunQueue runQueue,
        MongoDbContext db,
        ILogger<ChatRunsController> logger)
    {
        _sessionService = sessionService;
        _messageRepository = messageRepository;
        _groupMessageSeqService = groupMessageSeqService;
        _groupMessageStreamHub = groupMessageStreamHub;
        _runStore = runStore;
        _runQueue = runQueue;
        _db = db;
        _logger = logger;
    }

    private static string? GetUserId(ClaimsPrincipal user)
        => user.FindFirst("sub")?.Value ?? user.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;

    /// <summary>
    /// 创建对话 Run：立即落库/广播 user message，并返回 runId；LLM 由后台 worker 执行。
    /// </summary>
    [HttpPost("sessions/{sessionId}/messages/run")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> CreateRun(string sessionId, [FromBody] SendMessageRequest request, CancellationToken ct)
    {
        var sid = (sessionId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "sessionId 不能为空"));

        var (ok, err) = request.Validate();
        if (!ok) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "请求不合法"));

        var session = await _sessionService.GetByIdAsync(sid);
        if (session == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "会话不存在或已过期"));

        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "未授权"));

        var runId = Guid.NewGuid().ToString("N");
        var assistantMessageId = Guid.NewGuid().ToString("N");
        var userMessageId = Guid.NewGuid().ToString("N");

        // run meta：Queued
        var gid = (session.GroupId ?? string.Empty).Trim();
        var meta = new RunMeta
        {
            RunId = runId,
            Kind = RunKinds.Chat,
            Status = RunStatuses.Queued,
            GroupId = string.IsNullOrWhiteSpace(gid) ? null : gid,
            SessionId = sid,
            CreatedByUserId = userId,
            UserMessageId = userMessageId,
            AssistantMessageId = assistantMessageId,
            CreatedAt = DateTime.UtcNow,
            LastSeq = 0,
            CancelRequested = false,
            InputJson = JsonSerializer.Serialize(new
            {
                sessionId = sid,
                content = request.Content,
                promptKey = request.PromptKey,
                role = request.Role?.ToString(),
                attachmentIds = request.AttachmentIds ?? new List<string>(),
                userId
            }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase })
        };
        await _runStore.SetRunAsync(RunKinds.Chat, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
        await _runQueue.EnqueueAsync(RunKinds.Chat, runId, CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new
        {
            runId,
            userMessageId,
            assistantMessageId,
            groupSeq = (long?)null
        }));
    }

    [HttpGet("chat-runs/{runId}")]
    public async Task<IActionResult> GetRun(string runId, CancellationToken ct)
    {
        var rid = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(rid))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));
        var meta = await _runStore.GetRunAsync(RunKinds.Chat, rid, ct);
        if (meta == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.SESSION_NOT_FOUND, "run 不存在或已过期"));
        return Ok(ApiResponse<object>.Ok(meta));
    }

    [HttpPost("chat-runs/{runId}/cancel")]
    public async Task<IActionResult> Cancel(string runId, CancellationToken ct)
    {
        var rid = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(rid))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));
        await _runStore.TryMarkCancelRequestedAsync(RunKinds.Chat, rid, ct);
        return Ok(ApiResponse<object>.Ok(new { runId = rid, cancelRequested = true }));
    }

    /// <summary>
    /// 订阅对话 Run（SSE）：支持 afterSeq / Last-Event-ID 断线续传；先发 snapshot。
    /// </summary>
    [HttpGet("chat-runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task Stream(string runId, [FromQuery] long afterSeq = 0, CancellationToken cancellationToken = default)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var rid = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(rid))
        {
            var err = new StreamErrorEvent { Type = "error", ErrorCode = ErrorCodes.INVALID_FORMAT, ErrorMessage = "runId 不能为空" };
            await Response.WriteAsync($"event: error\ndata: {JsonSerializer.Serialize(err, AppJsonContext.Default.StreamErrorEvent)}\n\n", cancellationToken);
            return;
        }

        if (afterSeq <= 0)
        {
            var last = (Request.Headers["Last-Event-ID"].FirstOrDefault() ?? string.Empty).Trim();
            if (long.TryParse(last, out var parsed) && parsed > 0) afterSeq = parsed;
        }

        // 1) snapshot
        var snap = await _runStore.GetSnapshotAsync(RunKinds.Chat, rid, cancellationToken);
        if (snap != null && snap.Seq > afterSeq)
        {
            await Response.WriteAsync($"id: {snap.Seq}\n", cancellationToken);
            await Response.WriteAsync("event: message\n", cancellationToken);
            await Response.WriteAsync($"data: {snap.SnapshotJson}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);
            afterSeq = snap.Seq;
        }

        // 2) history + tail
        var lastKeepAliveAt = DateTime.UtcNow;
        while (!cancellationToken.IsCancellationRequested)
        {
            if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 10)
            {
                await Response.WriteAsync(": keepalive\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);
                lastKeepAliveAt = DateTime.UtcNow;
            }

            var batch = await _runStore.GetEventsAsync(RunKinds.Chat, rid, afterSeq, limit: 200, cancellationToken);
            if (batch.Count > 0)
            {
                foreach (var ev in batch)
                {
                    await Response.WriteAsync($"id: {ev.Seq}\n", cancellationToken);
                    await Response.WriteAsync("event: message\n", cancellationToken);
                    await Response.WriteAsync($"data: {ev.PayloadJson}\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                    afterSeq = ev.Seq;
                    lastKeepAliveAt = DateTime.UtcNow;
                }
            }
            else
            {
                // idle
                await Task.Delay(350, cancellationToken);
            }
        }
    }
}


