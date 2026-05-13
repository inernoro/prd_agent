using System.Text;
using System.Text.Json;
using PrdAgent.Api.Services.PrReview;

namespace PrdAgent.Api.Services.Streaming;

/// <summary>
/// 通用 AI 流式 SSE 写出帮助 (Compute-then-Send 兼容)
///
/// 用途: 把任意 <see cref="IAsyncEnumerable{LlmStreamDelta}"/> + <see cref="PrReviewModelInfoHolder"/>
/// 的流式服务一次性写成符合 useSseStream 协议的 SSE 响应:
///   event: phase    data: {"phase":"preparing"|"thinking"|"streaming","message":"...","elapsedMs":N}
///   event: model    data: {"model":"...","platform":"...","modelGroupName":"..."}
///   event: thinking data: {"text":"chunk"}
///   event: typing   data: {"text":"chunk"}
///   event: done     data: {"text":"<accumulated>","durationMs":N,"model":"...","platform":"..."}
///   event: error    data: {"message":"..."}
///
/// 内建:
///  - 心跳 phase 事件 (0-15s / 15-40s / 40s+ 分级文案)
///  - SemaphoreSlim writeLock 防止心跳与正文并发写
///  - 客户端断开容错 (catch ObjectDisposedException + OperationCanceledException)
///  - server-authority: 不向 service 传 HttpContext.RequestAborted, service 自己用 CT.None
///
/// 使用方式 (替代 ReportAgentController.PolishDailyLogItem 那 ~120 行 SSE 模板代码):
///
/// <code>
/// [HttpPost("polish/stream")]
/// [Produces("text/event-stream")]
/// public async Task PolishStream([FromBody] PolishRequest req)
/// {
///     await AiStreamingHelpers.WriteSseStreamAsync(
///         Response,
///         label: "AI 润色",
///         streamFactory: holder =&gt; _service.StreamPolishAsync(req.Text, req.StyleHint, holder, CT.None),
///         logger: _logger);
/// }
/// </code>
/// </summary>
public static class AiStreamingHelpers
{
    /// <summary>
    /// 写 SSE 流。<paramref name="streamFactory"/> 接收 <see cref="PrReviewModelInfoHolder"/>
    /// 返回 <see cref="IAsyncEnumerable{LlmStreamDelta}"/>, 内部按 PrReview 既定模式工作即可。
    /// </summary>
    /// <param name="response">Controller 的 HttpResponse</param>
    /// <param name="label">业务标签, 用于 phase 文案 (如 "AI 润色" / "PR 摘要")</param>
    /// <param name="streamFactory">委托: 接收 modelInfo holder, 返回流式 deltas</param>
    /// <param name="logger">用于异常日志</param>
    /// <param name="heartbeatInterval">心跳间隔, 默认 2 秒</param>
    /// <param name="onDone">流式结束时可附加的 done payload 字段 (调用方扩展用)</param>
    public static async Task WriteSseStreamAsync(
        HttpResponse response,
        string label,
        Func<PrReviewModelInfoHolder, IAsyncEnumerable<LlmStreamDelta>> streamFactory,
        ILogger logger,
        TimeSpan? heartbeatInterval = null,
        Func<object>? onDone = null)
    {
        response.ContentType = "text/event-stream";
        response.Headers.CacheControl = "no-cache";
        response.Headers.Connection = "keep-alive";
        response.Headers["X-Accel-Buffering"] = "no";

        var modelInfo = new PrReviewModelInfoHolder();
        var output = new StringBuilder();
        using var heartbeatCts = new CancellationTokenSource();
        using var writeLock = new SemaphoreSlim(1, 1);
        var firstChunk = true;
        var sawText = false;
        var startAt = DateTime.UtcNow;
        var interval = heartbeatInterval ?? TimeSpan.FromSeconds(2);

        async Task SafeWriteAsync(string evt, object data)
        {
            await writeLock.WaitAsync();
            try { await WriteEventAsync(response, evt, data); }
            catch (ObjectDisposedException) { /* 客户端已断 */ }
            catch (OperationCanceledException) { /* 客户端已断 */ }
            finally { writeLock.Release(); }
        }

        async Task RunHeartbeatAsync()
        {
            try
            {
                while (!heartbeatCts.IsCancellationRequested)
                {
                    try { await Task.Delay(interval, heartbeatCts.Token); }
                    catch (OperationCanceledException) { return; }
                    if (heartbeatCts.IsCancellationRequested) return;
                    var elapsed = (int)(DateTime.UtcNow - startAt).TotalSeconds;
                    var msg = elapsed < 15
                        ? $"{label} 正在生成　{elapsed}s"
                        : elapsed < 40
                            ? $"上游首字延迟较高, 已等待 {elapsed}s"
                            : $"⚠ 上游响应缓慢, 已等待 {elapsed}s, 可点击放弃后重试";
                    await SafeWriteAsync("phase", new { phase = "waiting", message = msg, elapsedMs = elapsed * 1000 });
                }
            }
            catch { /* swallow */ }
        }

        await SafeWriteAsync("phase", new { phase = "preparing", message = $"{label} 正在准备…" });
        var heartbeatTask = Task.Run(RunHeartbeatAsync);

        try
        {
            await foreach (var delta in streamFactory(modelInfo))
            {
                if (firstChunk)
                {
                    firstChunk = false;
                    heartbeatCts.Cancel();
                    try { await heartbeatTask; } catch { /* ignore */ }
                    await SafeWriteAsync("phase", new
                    {
                        phase = delta.IsThinking ? "thinking" : "streaming",
                        message = delta.IsThinking ? $"{label} 正在思考…" : $"{label} 正在输出…",
                    });
                }

                if (modelInfo.Captured)
                {
                    await SafeWriteAsync("model", new
                    {
                        model = modelInfo.Model,
                        platform = modelInfo.Platform,
                        modelGroupName = modelInfo.ModelGroupName,
                    });
                    modelInfo.Captured = false;
                }

                if (delta.IsThinking)
                {
                    await SafeWriteAsync("thinking", new { text = delta.Content });
                }
                else
                {
                    if (!sawText)
                    {
                        sawText = true;
                        await SafeWriteAsync("phase", new { phase = "streaming", message = $"{label} 正在输出…" });
                    }
                    output.Append(delta.Content);
                    await SafeWriteAsync("typing", new { text = delta.Content });
                }
            }

            var donePayload = new
            {
                text = output.ToString(),
                durationMs = (long)(DateTime.UtcNow - startAt).TotalMilliseconds,
                model = modelInfo.Model,
                platform = modelInfo.Platform,
                extra = onDone?.Invoke(),
            };
            await SafeWriteAsync("done", donePayload);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "{Label} stream failed", label);
            try { await SafeWriteAsync("error", new { message = $"{label}失败: " + ex.Message }); }
            catch { /* 客户端已断 */ }
        }
        finally
        {
            if (!heartbeatCts.IsCancellationRequested) heartbeatCts.Cancel();
            try { await heartbeatTask; } catch { /* ignore */ }
        }
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static async Task WriteEventAsync(HttpResponse response, string eventType, object data)
    {
        var json = JsonSerializer.Serialize(data, JsonOpts);
        await response.WriteAsync($"event: {eventType}\ndata: {json}\n\n");
        await response.Body.FlushAsync();
    }
}
