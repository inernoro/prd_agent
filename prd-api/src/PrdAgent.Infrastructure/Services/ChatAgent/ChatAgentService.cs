using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.ChatAgent;

/// <summary>
/// 通用对话智能体适配层实现。
///
/// 全文没有任何「问模型 - 调工具 - 回灌 - 再问」的循环，这是有意的硬约束：
/// 循环属于 agent 运行时里的官方 SDK，我们只负责把一轮转过去、把事件翻译回来。
/// 出现自研循环即触发设计文档里的红线熔断。
/// </summary>
public sealed class ChatAgentService : IChatAgentService
{
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    private readonly MongoDbContext _db;
    private readonly IClaudeSidecarRouter _runtime;
    private readonly IAgentToolRegistry _tools;
    private readonly IChatAgentTurnQueue _queue;
    private readonly IOptionsMonitor<ChatAgentOptions> _options;
    private readonly ILogger<ChatAgentService> _logger;

    public ChatAgentService(
        MongoDbContext db,
        IClaudeSidecarRouter runtime,
        IAgentToolRegistry tools,
        IChatAgentTurnQueue queue,
        IOptionsMonitor<ChatAgentOptions> options,
        ILogger<ChatAgentService> logger)
    {
        _db = db;
        _runtime = runtime;
        _tools = tools;
        _queue = queue;
        _options = options;
        _logger = logger;
    }

    // ──────────────────────────────────────────────────────────────
    // 会话
    // ──────────────────────────────────────────────────────────────

    public async Task<IReadOnlyList<ChatAgentSessionView>> ListSessionsAsync(string userId, CancellationToken ct)
    {
        var items = await _db.ChatAgentSessions
            .Find(OwnedByFilter(userId))
            .SortByDescending(s => s.UpdatedAt)
            .Limit(200)
            .ToListAsync(ct);

        return items.Select(ToView).ToList();
    }

    public async Task<ChatAgentSessionView> CreateSessionAsync(
        string userId, string? title, string? model, CancellationToken ct)
    {
        var session = new ChatAgentSession
        {
            UserId = userId,
            Title = string.IsNullOrWhiteSpace(title) ? "新会话" : title.Trim(),
            Model = string.IsNullOrWhiteSpace(model) ? null : model.Trim(),
            DeploymentSlug = DeploymentScope.Current,
        };
        await _db.ChatAgentSessions.InsertOneAsync(session, cancellationToken: ct);
        return ToView(session);
    }

    public async Task<ChatAgentSessionView?> GetSessionAsync(string userId, string sessionId, CancellationToken ct)
    {
        var session = await LoadOwnedAsync(userId, sessionId, ct);
        return session == null ? null : ToView(session);
    }

    public async Task<ChatAgentSessionView?> RenameSessionAsync(
        string userId, string sessionId, string title, CancellationToken ct)
    {
        var trimmed = title.Trim();
        if (trimmed.Length == 0) return null;

        var updated = await _db.ChatAgentSessions.FindOneAndUpdateAsync(
            OwnedByFilter(userId) & Builders<ChatAgentSession>.Filter.Eq(s => s.Id, sessionId),
            Builders<ChatAgentSession>.Update
                .Set(s => s.Title, trimmed)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<ChatAgentSession> { ReturnDocument = ReturnDocument.After },
            ct);

        return updated == null ? null : ToView(updated);
    }

    public async Task<bool> DeleteSessionAsync(string userId, string sessionId, CancellationToken ct)
    {
        // 软删除：历史事件与消息保留，排障时还能查。
        var res = await _db.ChatAgentSessions.UpdateOneAsync(
            OwnedByFilter(userId) & Builders<ChatAgentSession>.Filter.Eq(s => s.Id, sessionId),
            Builders<ChatAgentSession>.Update
                .Set(s => s.Deleted, true)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return res.ModifiedCount > 0;
    }

    // ──────────────────────────────────────────────────────────────
    // 消息
    // ──────────────────────────────────────────────────────────────

    public async Task<IReadOnlyList<ChatAgentMessageView>> ListMessagesAsync(
        string userId, string sessionId, int limit, CancellationToken ct)
    {
        var session = await LoadOwnedAsync(userId, sessionId, ct);
        if (session == null) return Array.Empty<ChatAgentMessageView>();

        var capped = Math.Clamp(limit, 1, 500);
        var items = await _db.ChatAgentMessages
            .Find(Builders<ChatAgentMessage>.Filter.Eq(m => m.SessionId, sessionId))
            .SortByDescending(m => m.CreatedAt)
            .ThenByDescending(m => m.Ordinal)
            .Limit(capped)
            .ToListAsync(ct);

        // 倒序取最近 N 条再翻回来，得到按 (CreatedAt, Ordinal) 升序的一页
        items.Reverse();
        return items.Select(ToView).ToList();
    }

    public async Task<ChatAgentTurnAccepted> SendMessageAsync(
        string userId, string sessionId, string content, CancellationToken ct)
    {
        var session = await LoadOwnedAsync(userId, sessionId, ct)
                      ?? throw new InvalidOperationException("会话不存在");

        if (!string.IsNullOrEmpty(session.RunningTurnId))
            throw new InvalidOperationException("这个会话还有一轮没跑完，等它结束再发");

        var trimmed = content.Trim();
        if (trimmed.Length == 0)
            throw new InvalidOperationException("消息不能为空");

        var turnId = Guid.NewGuid().ToString("N");
        var scope = DeploymentScope.Current;

        var userMessage = new ChatAgentMessage
        {
            SessionId = sessionId,
            TurnId = turnId,
            Role = ChatAgentRoles.User,
            Ordinal = 0,
            Content = trimmed,
            Status = ChatAgentMessageStatus.Completed,
            CompletedAt = DateTime.UtcNow,
            DeploymentSlug = scope,
        };
        var assistantMessage = new ChatAgentMessage
        {
            SessionId = sessionId,
            TurnId = turnId,
            Role = ChatAgentRoles.Assistant,
            Ordinal = 1,
            Content = string.Empty,
            Status = ChatAgentMessageStatus.Running,
            DeploymentSlug = scope,
        };
        // 服务端权威：接单这几步一旦开始就必须整体落地，客户端断开不许把它撕成半截。
        await _db.ChatAgentMessages.InsertManyAsync(new[] { userMessage, assistantMessage }, cancellationToken: CancellationToken.None);

        // 首条用户消息顺手把会话标题定下来，省得列表里一排「新会话」。
        var titleUpdate = Builders<ChatAgentSession>.Update
            .Set(s => s.RunningTurnId, turnId)
            .Set(s => s.UpdatedAt, DateTime.UtcNow);
        if (session.Title == "新会话")
        {
            var title = trimmed.Length > _options.CurrentValue.TitleLength
                ? trimmed[.._options.CurrentValue.TitleLength] + "…"
                : trimmed;
            titleUpdate = titleUpdate.Set(s => s.Title, title);
        }
        await _db.ChatAgentSessions.UpdateOneAsync(
            Builders<ChatAgentSession>.Filter.Eq(s => s.Id, sessionId), titleUpdate, cancellationToken: CancellationToken.None);

        var seq = await AppendEventAsync(sessionId, turnId, ChatAgentEventTypes.TurnStarted, new
        {
            turnId,
            userMessageId = userMessage.Id,
            assistantMessageId = assistantMessage.Id,
        }, CancellationToken.None);

        // 记下本轮起始序号，断线重连据此精确补齐本轮增量。
        await _db.ChatAgentSessions.UpdateOneAsync(
            Builders<ChatAgentSession>.Filter.Eq(s => s.Id, sessionId),
            Builders<ChatAgentSession>.Update.Set(s => s.RunningTurnStartSeq, seq),
            cancellationToken: CancellationToken.None);

        // 入队后立刻返回：这一轮的生命周期与 HTTP 请求解绑，客户端断开不取消它。
        await _queue.EnqueueAsync(new ChatAgentTurnJob(sessionId, turnId), CancellationToken.None);

        return new ChatAgentTurnAccepted(turnId, userMessage.Id, assistantMessage.Id, seq);
    }

    // ──────────────────────────────────────────────────────────────
    // 一轮的执行：转发给运行时 + 翻译事件。没有循环。
    // ──────────────────────────────────────────────────────────────

    public async Task RunTurnAsync(string sessionId, string turnId, CancellationToken ct)
    {
        var session = await _db.ChatAgentSessions
            .Find(Builders<ChatAgentSession>.Filter.Eq(s => s.Id, sessionId))
            .FirstOrDefaultAsync(ct);
        if (session == null)
        {
            _logger.LogWarning("[ChatAgent] 轮次的会话已不存在 session={SessionId} turn={TurnId}", sessionId, turnId);
            return;
        }

        var opts = _options.CurrentValue;
        var history = await BuildHistoryAsync(sessionId, turnId, opts.HistoryLimit, ct);

        var request = new SidecarRunRequest
        {
            RunId = turnId,
            Model = string.IsNullOrWhiteSpace(session.Model) ? opts.Model : session.Model!,
            SystemPrompt = opts.SystemPrompt,
            Messages = history,
            // 工具只按白名单暴露，且实现全是转发（出图转给出图流水线，
            // 存/搜/读知识库转给文档空间）。要不要用、什么时候用由官方套件决定，我们不写调度。
            Tools = BuildTools(opts),
            // 空数组 = 连运行时自带的只读文件工具也不开。通用对话不该顺带具备读仓库的能力。
            BuiltinTools = Array.Empty<string>(),
            MaxTokens = opts.MaxTokens,
            MaxTurns = opts.MaxTurns,
            TimeoutSeconds = opts.TimeoutSeconds,
            MapSessionId = sessionId,
            TraceId = turnId,
            StickyKey = sessionId,
            AppCallerCode = AppCallerRegistry.ChatAgent.Conversation,
        };

        var text = new StringBuilder();
        long? inputTokens = null;
        long? outputTokens = null;
        var finished = false;

        try
        {
            await foreach (var evt in _runtime.RunStreamAsync(request, ct))
            {
                switch (evt.Type)
                {
                    case SidecarEventType.TextDelta:
                        if (string.IsNullOrEmpty(evt.Text)) break;
                        text.Append(evt.Text);
                        await AppendEventAsync(sessionId, turnId, ChatAgentEventTypes.TextDelta,
                            new { text = evt.Text }, ct);
                        break;

                    case SidecarEventType.Thinking:
                        if (string.IsNullOrEmpty(evt.Text)) break;
                        await AppendEventAsync(sessionId, turnId, ChatAgentEventTypes.Thinking,
                            new { text = evt.Text }, ct);
                        break;

                    case SidecarEventType.Usage:
                        inputTokens = evt.InputTokens ?? inputTokens;
                        outputTokens = evt.OutputTokens ?? outputTokens;
                        await AppendEventAsync(sessionId, turnId, ChatAgentEventTypes.Usage,
                            new { inputTokens = evt.InputTokens, outputTokens = evt.OutputTokens }, ct);
                        break;

                    case SidecarEventType.Done:
                        // 运行时给了定稿全文就以它为准，否则用累积的增量拼。
                        if (!string.IsNullOrEmpty(evt.FinalText))
                        {
                            text.Clear();
                            text.Append(evt.FinalText);
                        }
                        inputTokens = evt.InputTokens ?? inputTokens;
                        outputTokens = evt.OutputTokens ?? outputTokens;
                        await CompleteTurnAsync(sessionId, turnId, text.ToString(), inputTokens, outputTokens, ct);
                        finished = true;
                        break;

                    case SidecarEventType.Error:
                        await FailTurnAsync(sessionId, turnId, text.ToString(),
                            evt.ErrorCode ?? "runtime_error",
                            HumanizeError(evt.ErrorCode, evt.Message), ct);
                        finished = true;
                        break;

                    case SidecarEventType.ToolUse:
                        var toolName = ChatAgentToolPresentation.NormalizeToolName(evt.ToolName);
                        await AppendEventAsync(sessionId, turnId, ChatAgentEventTypes.ToolStarted, new
                        {
                            toolUseId = evt.ToolUseId,
                            tool = toolName,
                            label = ChatAgentToolPresentation.ToolLabel(toolName),
                            steps = ChatAgentToolPresentation.ToolSteps(toolName),
                        }, ct);
                        break;

                    case SidecarEventType.ToolResult:
                        await AppendEventAsync(sessionId, turnId, ChatAgentEventTypes.ToolFinished,
                            ChatAgentToolPresentation.BuildToolCardPayload(
                                evt.ToolName, evt.ToolUseId, evt.Content, evt.IsError), ct);
                        break;

                    case SidecarEventType.Keepalive:
                    case SidecarEventType.RuntimeInit:
                    case SidecarEventType.Unknown:
                    default:
                        break;
                }

                if (finished) break;
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            await FailTurnAsync(sessionId, turnId, text.ToString(),
                "server_shutdown", "服务重启打断了这一轮，可以重新发一次。", CancellationToken.None);
            return;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[ChatAgent] 轮次执行失败 session={SessionId} turn={TurnId}", sessionId, turnId);
            await FailTurnAsync(sessionId, turnId, text.ToString(),
                "adapter_error", "转发给运行时时出错了：" + ex.Message, CancellationToken.None);
            return;
        }

        if (!finished)
        {
            // 运行时把流断了却没给终态，这本身就是异常，不能让会话永远挂着「进行中」。
            await FailTurnAsync(sessionId, turnId, text.ToString(),
                "runtime_stream_closed", "运行时提前断开了，没有给出结束标记。可以重新发一次。", CancellationToken.None);
        }
    }

    // ──────────────────────────────────────────────────────────────
    // 事件读取（SSE 续订用）
    // ──────────────────────────────────────────────────────────────

    public async Task<ChatAgentEventPage> ReadEventsAsync(
        string userId, string sessionId, long afterSeq, int limit, CancellationToken ct)
    {
        var session = await LoadOwnedAsync(userId, sessionId, ct);
        if (session == null) return new ChatAgentEventPage(Array.Empty<ChatAgentEventView>(), afterSeq, false);

        var capped = Math.Clamp(limit, 1, 500);
        var items = await _db.ChatAgentEvents
            .Find(Builders<ChatAgentEvent>.Filter.Eq(e => e.SessionId, sessionId)
                  & Builders<ChatAgentEvent>.Filter.Gt(e => e.Seq, afterSeq))
            .SortBy(e => e.Seq)
            .Limit(capped)
            .ToListAsync(ct);

        var last = items.Count > 0 ? items[^1].Seq : afterSeq;
        var views = items
            .Select(e => new ChatAgentEventView(e.Seq, e.TurnId, e.Type, e.PayloadJson, e.CreatedAt))
            .ToList();

        return new ChatAgentEventPage(views, last, !string.IsNullOrEmpty(session.RunningTurnId));
    }

    // ──────────────────────────────────────────────────────────────
    // 内部
    // ──────────────────────────────────────────────────────────────

    /// <summary>只看自己的、没删的会话。所有读写入口都必须先过这一层。</summary>
    private static FilterDefinition<ChatAgentSession> OwnedByFilter(string userId) =>
        Builders<ChatAgentSession>.Filter.Eq(s => s.UserId, userId)
        & Builders<ChatAgentSession>.Filter.Ne(s => s.Deleted, true);

    private Task<ChatAgentSession?> LoadOwnedAsync(string userId, string sessionId, CancellationToken ct) =>
        _db.ChatAgentSessions
            .Find(OwnedByFilter(userId) & Builders<ChatAgentSession>.Filter.Eq(s => s.Id, sessionId))
            .FirstOrDefaultAsync(ct)!;

    private async Task<List<SidecarChatMessage>> BuildHistoryAsync(
        string sessionId, string turnId, int limit, CancellationToken ct)
    {
        var items = await _db.ChatAgentMessages
            .Find(Builders<ChatAgentMessage>.Filter.Eq(m => m.SessionId, sessionId))
            .SortByDescending(m => m.CreatedAt)
            .ThenByDescending(m => m.Ordinal)
            .Limit(Math.Clamp(limit, 2, 200))
            .ToListAsync(ct);

        items.Reverse();

        // 本轮的助手占位消息还是空的，带上去只会污染上下文；失败轮的空消息同理。
        return items
            .Where(m => m.Content.Length > 0)
            .Where(m => !(m.TurnId == turnId && m.Role == ChatAgentRoles.Assistant))
            .Select(m => new SidecarChatMessage { Role = m.Role, Content = m.Content })
            .ToList();
    }

    /// <summary>
    /// 取号并落事件。序号来自会话文档的原子自增，保证同一会话内单调递增，
    /// 前端才能按 afterSeq 精确续订。
    /// </summary>
    private async Task<long> AppendEventAsync(
        string sessionId, string turnId, string type, object payload, CancellationToken ct)
    {
        // ct 只用于「要不要继续拉流」；落库一律用 None，
        // 否则关闭或断开会把已经收到的内容丢掉（server-authority 规则 1）。
        _ = ct;
        var session = await _db.ChatAgentSessions.FindOneAndUpdateAsync(
            Builders<ChatAgentSession>.Filter.Eq(s => s.Id, sessionId),
            Builders<ChatAgentSession>.Update.Inc(s => s.EventSeq, 1L),
            new FindOneAndUpdateOptions<ChatAgentSession> { ReturnDocument = ReturnDocument.After },
            CancellationToken.None);

        if (session == null) return 0;

        await _db.ChatAgentEvents.InsertOneAsync(new ChatAgentEvent
        {
            SessionId = sessionId,
            TurnId = turnId,
            Seq = session.EventSeq,
            Type = type,
            PayloadJson = JsonSerializer.Serialize(payload, JsonOpts),
            DeploymentSlug = DeploymentScope.Current,
        }, cancellationToken: CancellationToken.None);

        return session.EventSeq;
    }

    private async Task CompleteTurnAsync(
        string sessionId, string turnId, string content, long? inputTokens, long? outputTokens, CancellationToken ct)
    {
        await _db.ChatAgentMessages.UpdateOneAsync(
            AssistantOfTurn(sessionId, turnId),
            Builders<ChatAgentMessage>.Update
                .Set(m => m.Content, content)
                .Set(m => m.Status, ChatAgentMessageStatus.Completed)
                .Set(m => m.InputTokens, inputTokens)
                .Set(m => m.OutputTokens, outputTokens)
                .Set(m => m.CompletedAt, DateTime.UtcNow),
            cancellationToken: ct);

        await AppendEventAsync(sessionId, turnId, ChatAgentEventTypes.Done,
            new { text = content, inputTokens, outputTokens }, ct);

        await ClearRunningAsync(sessionId, turnId, ct);
    }

    private async Task FailTurnAsync(
        string sessionId, string turnId, string partial, string code, string message, CancellationToken ct)
    {
        await _db.ChatAgentMessages.UpdateOneAsync(
            AssistantOfTurn(sessionId, turnId),
            Builders<ChatAgentMessage>.Update
                .Set(m => m.Content, partial)
                .Set(m => m.Status, ChatAgentMessageStatus.Failed)
                .Set(m => m.ErrorCode, code)
                .Set(m => m.Error, message)
                .Set(m => m.CompletedAt, DateTime.UtcNow),
            cancellationToken: ct);

        await AppendEventAsync(sessionId, turnId, ChatAgentEventTypes.Error,
            new { code, message, partial }, ct);

        await ClearRunningAsync(sessionId, turnId, ct);
    }

    /// <summary>
    /// 只在「当前正在跑的确实是这一轮」时才清空。多个 worker 或重试并存时，
    /// 无条件清空会把别人正在跑的轮次误判成空闲。
    /// </summary>
    private Task ClearRunningAsync(string sessionId, string turnId, CancellationToken ct) =>
        _db.ChatAgentSessions.UpdateOneAsync(
            Builders<ChatAgentSession>.Filter.Eq(s => s.Id, sessionId)
            & Builders<ChatAgentSession>.Filter.Eq(s => s.RunningTurnId, turnId),
            Builders<ChatAgentSession>.Update
                .Set(s => s.RunningTurnId, (string?)null)
                .Set(s => s.RunningTurnStartSeq, (long?)null)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

    private static FilterDefinition<ChatAgentMessage> AssistantOfTurn(string sessionId, string turnId) =>
        Builders<ChatAgentMessage>.Filter.Eq(m => m.SessionId, sessionId)
        & Builders<ChatAgentMessage>.Filter.Eq(m => m.TurnId, turnId)
        & Builders<ChatAgentMessage>.Filter.Eq(m => m.Role, ChatAgentRoles.Assistant);

    /// <summary>按白名单取工具描述，交给运行时。白名单为空就是真的不给工具。</summary>
    private List<SidecarToolDef> BuildTools(ChatAgentOptions opts)
    {
        var list = new List<SidecarToolDef>();
        foreach (var d in _tools.Filter(opts.Tools))
        {
            JsonElement schema;
            try
            {
                schema = JsonDocument.Parse(d.InputSchemaJson).RootElement.Clone();
            }
            catch (JsonException ex)
            {
                // 某把工具的 schema 坏了不该让整个对话不可用：跳过它并留下痕迹。
                _logger.LogError(ex, "[ChatAgent] 工具 {Tool} 的入参 schema 无法解析，本轮跳过", d.Name);
                continue;
            }
            list.Add(new SidecarToolDef { Name = d.Name, Description = d.Description, InputSchema = schema });
        }
        return list;
    }

    /// <summary>
    /// 把运行时的错误码翻成用户能看懂的一句话。翻不了就原样透出，
    /// 但绝不吞掉——失败必须说清楚是哪一层的问题。
    /// </summary>
    private static string HumanizeError(string? code, string? message) => code switch
    {
        "sidecar_not_configured" => "对话运行时还没配置好，管理员需要先启用它。",
        "no_healthy_sidecar" => "对话运行时暂时不可用，稍后再试或联系管理员。",
        "sidecar_token_missing" => "对话运行时缺少访问凭据，管理员需要补上配置。",
        _ => string.IsNullOrWhiteSpace(message) ? "这一轮失败了，可以重新发一次。" : message!,
    };

    private ChatAgentSessionView ToView(ChatAgentSession s) => new(
        s.Id,
        s.Title,
        s.Model,
        string.IsNullOrWhiteSpace(s.Model) ? _options.CurrentValue.Model : s.Model!,
        !string.IsNullOrEmpty(s.RunningTurnId),
        s.EventSeq,
        s.RunningTurnStartSeq,
        s.CreatedAt,
        s.UpdatedAt);

    private static ChatAgentMessageView ToView(ChatAgentMessage m) => new(
        m.Id, m.TurnId, m.Role, m.Content, m.Status, m.Error, m.ErrorCode,
        m.InputTokens, m.OutputTokens, m.CreatedAt, m.CompletedAt);
}
