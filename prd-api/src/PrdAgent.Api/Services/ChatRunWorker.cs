using System.Text;
using System.Text.Json;
using PrdAgent.Api.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 对话 Run 后台执行器：将 LLM 调用与 HTTP SSE 连接解耦，避免客户端断线中断服务端闭环。
/// </summary>
public sealed class ChatRunWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRunQueue _queue;
    private readonly IRunEventStore _runStore;
    private readonly ILogger<ChatRunWorker> _logger;

    public ChatRunWorker(IServiceScopeFactory scopeFactory, IRunQueue queue, IRunEventStore runStore, ILogger<ChatRunWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _queue = queue;
        _runStore = runStore;
        _logger = logger;
    }

    private sealed record ChatRunInput(
        string SessionId,
        string Content,
        string? PromptKey,
        string? UserId,
        List<string>? AttachmentIds,
        UserRole? AnswerAsRole,
        string? ResolvedPromptTemplate = null,
        string? SystemPromptOverride = null,
        bool DisableGroupContext = false);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            string? runId = null;
            try
            {
                runId = await _queue.DequeueAsync(RunKinds.Chat, TimeSpan.FromSeconds(1), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "ChatRunWorker dequeue failed");
            }

            if (string.IsNullOrWhiteSpace(runId))
            {
                try
                {
                    await Task.Delay(300, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                continue;
            }

            try
            {
                await ProcessRunAsync(runId.Trim(), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "ChatRunWorker process failed: {RunId}", runId);
                try
                {
                    var meta = await _runStore.GetRunAsync(RunKinds.Chat, runId, CancellationToken.None);
                    if (meta != null)
                    {
                        meta.Status = RunStatuses.Error;
                        meta.EndedAt = DateTime.UtcNow;
                        meta.ErrorCode = ErrorCodes.INTERNAL_ERROR;
                        meta.ErrorMessage = ex.Message;
                        await _runStore.SetRunAsync(RunKinds.Chat, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
                        await _runStore.AppendEventAsync(RunKinds.Chat, runId, "message",
                            new ChatStreamEvent { Type = "error", ErrorCode = ErrorCodes.INTERNAL_ERROR, ErrorMessage = ex.Message, MessageId = meta.AssistantMessageId },
                            ttl: TimeSpan.FromHours(24),
                            ct: CancellationToken.None);
                    }
                }
                catch
                {
                    // ignore
                }
            }
        }
    }

    private static ChatRunInput? ParseInput(string? inputJson)
    {
        if (string.IsNullOrWhiteSpace(inputJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(inputJson);
            var root = doc.RootElement;
            var sessionId = root.TryGetProperty("sessionId", out var sid) ? (sid.GetString() ?? "") : "";
            var content = root.TryGetProperty("content", out var c) ? (c.GetString() ?? "") : "";
            var promptKey = root.TryGetProperty("promptKey", out var pk) ? pk.GetString() : null;
            var userId = root.TryGetProperty("userId", out var uid) ? uid.GetString() : null;
            // 新字段：answerAsRole；兼容旧字段：role
            var roleRaw = root.TryGetProperty("answerAsRole", out var ar) ? ar.GetString()
                : (root.TryGetProperty("role", out var r) ? r.GetString() : null);
            var answerRole = TryParseUserRole(roleRaw);
            List<string>? atts = null;
            if (root.TryGetProperty("attachmentIds", out var a) && a.ValueKind == JsonValueKind.Array)
            {
                atts = new List<string>();
                foreach (var it in a.EnumerateArray())
                {
                    if (it.ValueKind != JsonValueKind.String) continue;
                    var s = (it.GetString() ?? "").Trim();
                    if (!string.IsNullOrWhiteSpace(s)) atts.Add(s);
                }
            }
            // 技能执行：解析已解析的提示词模板和系统提示词覆盖
            var resolvedPrompt = root.TryGetProperty("resolvedPromptTemplate", out var rpt) ? rpt.GetString() : null;
            var sysOverride = root.TryGetProperty("systemPromptOverride", out var spo) ? spo.GetString() : null;

            // 技能上下文范围：contextScope 为 prd 或 none 时禁用群上下文（仅系统提示词+PRD+当前消息）
            var contextScope = root.TryGetProperty("contextScope", out var cs) ? cs.GetString() : null;
            var disableCtx = contextScope is "prd" or "none";

            sessionId = sessionId.Trim();
            content = content.Trim();
            if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(content)) return null;
            return new ChatRunInput(
                sessionId,
                content,
                string.IsNullOrWhiteSpace(promptKey) ? null : promptKey.Trim(),
                string.IsNullOrWhiteSpace(userId) ? null : userId.Trim(),
                atts,
                answerRole,
                string.IsNullOrWhiteSpace(resolvedPrompt) ? null : resolvedPrompt.Trim(),
                string.IsNullOrWhiteSpace(sysOverride) ? null : sysOverride.Trim(),
                DisableGroupContext: disableCtx);
        }
        catch
        {
            return null;
        }
    }

    private static UserRole? TryParseUserRole(string? raw)
    {
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return null;
        // 兼容：pm/dev/qa/admin 以及 PM/DEV/QA/ADMIN
        s = s.ToUpperInvariant();
        if (s == "PM") return UserRole.PM;
        if (s == "DEV") return UserRole.DEV;
        if (s == "QA") return UserRole.QA;
        if (s == "ADMIN") return UserRole.ADMIN;
        return null;
    }

    /// <summary>
    /// 构建有效的系统提示词覆盖：技能执行时优先使用已解析的模板
    /// </summary>
    private static string? BuildEffectiveSystemOverride(ChatRunInput input)
    {
        if (input.ResolvedPromptTemplate == null && input.SystemPromptOverride == null)
            return null;

        var parts = new List<string>();

        if (!string.IsNullOrWhiteSpace(input.SystemPromptOverride))
            parts.Add(input.SystemPromptOverride);

        if (!string.IsNullOrWhiteSpace(input.ResolvedPromptTemplate))
            parts.Add($"## 技能指令\n\n{input.ResolvedPromptTemplate}");

        return string.Join("\n\n", parts);
    }

    private async Task ProcessRunAsync(string runId, CancellationToken stoppingToken)
    {
        var meta = await _runStore.GetRunAsync(RunKinds.Chat, runId, stoppingToken);
        if (meta == null) return;
        if (meta.Status is RunStatuses.Done or RunStatuses.Error or RunStatuses.Cancelled) return;

        var input = ParseInput(meta.InputJson);
        if (input == null)
        {
            meta.Status = RunStatuses.Error;
            meta.EndedAt = DateTime.UtcNow;
            meta.ErrorCode = ErrorCodes.INVALID_FORMAT;
            meta.ErrorMessage = "run input 为空或不合法";
            await _runStore.SetRunAsync(RunKinds.Chat, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
            await _runStore.AppendEventAsync(RunKinds.Chat, runId, "message",
                new ChatStreamEvent { Type = "error", ErrorCode = ErrorCodes.INVALID_FORMAT, ErrorMessage = "run input 为空或不合法", MessageId = meta.AssistantMessageId },
                ttl: TimeSpan.FromHours(24),
                ct: CancellationToken.None);
            return;
        }

        meta.Status = RunStatuses.Running;
        meta.StartedAt = DateTime.UtcNow;
        await _runStore.SetRunAsync(RunKinds.Chat, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);

        using var scope = _scopeFactory.CreateScope();
        var chat = scope.ServiceProvider.GetRequiredService<IChatService>();

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        _ = Task.Run(async () =>
        {
            // cancel poll: 仅显式 stop 才会设置 cancelRequested
            while (!cts.IsCancellationRequested && !stoppingToken.IsCancellationRequested)
            {
                try
                {
                    if (await _runStore.IsCancelRequestedAsync(RunKinds.Chat, runId, CancellationToken.None))
                    {
                        cts.Cancel();
                        break;
                    }
                }
                catch
                {
                    // ignore
                }
                await Task.Delay(200);
            }
        }, CancellationToken.None);

        var assembled = new StringBuilder();
        var lastSnapshotAt = DateTime.UtcNow;
        var lastSnapshotSeq = 0L;
        string? lastType = null;

        try
        {
            // 构建系统提示词覆盖（技能模式：resolvedPromptTemplate + systemPromptOverride）
            var effectiveSystemOverride = BuildEffectiveSystemOverride(input);

            await foreach (var ev in chat.SendMessageAsync(
                               input.SessionId,
                               input.Content,
                               resendOfMessageId: null,
                               input.PromptKey,
                               input.UserId,
                               input.AttachmentIds,
                               runId: runId,
                               fixedUserMessageId: meta.UserMessageId,
                               fixedAssistantMessageId: meta.AssistantMessageId,
                               disableGroupContext: input.DisableGroupContext,
                               systemPromptOverride: effectiveSystemOverride,
                               answerAsRole: input.AnswerAsRole,
                               cancellationToken: cts.Token))
            {
                lastType = ev.Type;
                // 事件落 store（用于 SSE 断线续传）
                var seq = await _runStore.AppendEventAsync(RunKinds.Chat, runId, "message", ev, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
                meta.LastSeq = seq;

                // 利用 blockDelta 重建全文，用于 snapshot（方案A）
                if (ev.Type == "blockDelta" && !string.IsNullOrEmpty(ev.Content))
                {
                    assembled.Append(ev.Content);
                }

                // snapshot：节流（避免高频写）
                if ((DateTime.UtcNow - lastSnapshotAt).TotalMilliseconds >= 350 && assembled.Length > 0)
                {
                    if (seq > lastSnapshotSeq)
                    {
                        var snapEvent = new ChatStreamEvent
                        {
                            Type = "snapshot",
                            MessageId = meta.AssistantMessageId,
                            Content = assembled.ToString()
                        };
                        var snapJson = JsonSerializer.Serialize(snapEvent, AppJsonContext.Default.ChatStreamEvent);
                        await _runStore.SetSnapshotAsync(RunKinds.Chat, runId,
                            new RunSnapshot { Seq = seq, SnapshotJson = snapJson, UpdatedAt = DateTime.UtcNow },
                            ttl: TimeSpan.FromHours(24),
                            ct: CancellationToken.None);
                        lastSnapshotAt = DateTime.UtcNow;
                        lastSnapshotSeq = seq;
                    }
                }

                // 终止条件：done 或 error
                if (ev.Type is "done" or "error")
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // 显式 stop：必须落状态，保证客户端重连可见“已取消”而非卡在 Running
            meta.Status = RunStatuses.Cancelled;
            meta.EndedAt = DateTime.UtcNow;
            await _runStore.SetRunAsync(RunKinds.Chat, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
            return;
        }

        // 如果已设置 cancelRequested，则标记 Cancelled；否则 Done（ChatService 内部失败会 yield error 并 break）
        var cancel = await _runStore.IsCancelRequestedAsync(RunKinds.Chat, runId, CancellationToken.None);

        // 结束兜底：确保至少写入一次 snapshot（方案A），避免短回答“来不及节流”导致重连看不到已生成内容
        if (!cancel && assembled.Length > 0 && meta.LastSeq > 0 && meta.LastSeq > lastSnapshotSeq)
        {
            var snapEvent = new ChatStreamEvent
            {
                Type = "snapshot",
                MessageId = meta.AssistantMessageId,
                Content = assembled.ToString()
            };
            var snapJson = JsonSerializer.Serialize(snapEvent, AppJsonContext.Default.ChatStreamEvent);
            await _runStore.SetSnapshotAsync(RunKinds.Chat, runId,
                new RunSnapshot { Seq = meta.LastSeq, SnapshotJson = snapJson, UpdatedAt = DateTime.UtcNow },
                ttl: TimeSpan.FromHours(24),
                ct: CancellationToken.None);
        }

        if (cancel)
        {
            meta.Status = RunStatuses.Cancelled;
            meta.EndedAt = DateTime.UtcNow;
        }
        else
        {
            meta.Status = lastType == "error" ? RunStatuses.Error : RunStatuses.Done;
            meta.EndedAt = DateTime.UtcNow;
        }
        await _runStore.SetRunAsync(RunKinds.Chat, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
    }
}


