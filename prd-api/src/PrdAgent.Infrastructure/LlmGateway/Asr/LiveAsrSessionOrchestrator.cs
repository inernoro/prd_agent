using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.LlmGateway.Asr;

/// <summary>
/// 实时 ASR 的传输边界。宿主只负责把 WebSocket 等具体协议适配为开始信号、
/// 已验序音频帧和下行事件；候选、通道及故障切换由基础设施编排器统一管理。
/// </summary>
public interface ILiveAsrSessionTransport
{
    Task<bool> ReceiveStartAsync();

    Task ReceiveFramesAsync(
        IReadOnlyList<ChannelWriter<LiveAsrAudioFrame>> writers,
        Func<LiveAsrEvent, Task> emit,
        CancellationToken cancellationToken);
}

public sealed record LiveAsrOrchestrationResult(
    LiveAsrSessionResult? SessionResult,
    string? Failure);

/// <summary>
/// 实时 ASR 会话的核心编排：模型解析、流式候选切换、双通道生命周期和滚动窗口兜底。
/// Serving host 仅组装传输、治理、日志与预算回调。
/// </summary>
public sealed class LiveAsrSessionOrchestrator
{
    private readonly IModelResolver _resolver;
    private readonly DoubaoStreamAsrService _asr;
    private readonly LiveAsrBatchFallbackService _batchFallback;
    private readonly ILogger<LiveAsrSessionOrchestrator> _logger;

    public LiveAsrSessionOrchestrator(
        IModelResolver resolver,
        DoubaoStreamAsrService asr,
        LiveAsrBatchFallbackService batchFallback,
        ILogger<LiveAsrSessionOrchestrator> logger)
    {
        _resolver = resolver;
        _asr = asr;
        _batchFallback = batchFallback;
        _logger = logger;
    }

    public async Task<LiveAsrOrchestrationResult> ExecuteAsync(
        ILiveAsrSessionTransport transport,
        GatewayRequestContext requestContext,
        Func<LiveAsrEvent, Task> emit,
        Action onUpstreamRequest)
    {
        LiveAsrSessionResult? sessionResult = null;
        string? sessionFailure = null;
        Channel<LiveAsrAudioFrame>? frames = null;
        Channel<LiveAsrAudioFrame>? batchFrames = null;
        Task? receiveTask = null;
        using var receiveCancellation = new CancellationTokenSource();
        try
        {
            if (!await transport.ReceiveStartAsync())
            {
                sessionFailure = "实时转写缺少合法 start 控制消息";
                await emit(new LiveAsrEvent
                {
                    Type = LiveAsrEventTypes.Error,
                    ErrorCode = "LIVE_ASR_START_INVALID",
                    Message = sessionFailure,
                });
                return new LiveAsrOrchestrationResult(sessionResult, sessionFailure);
            }

            // 一个会话只解析一次完整候选计划。流式与批量降级都从同一模型池快照筛选，
            // 避免健康状态或配置在两次查询间变化后混用不一致的候选。
            var plan = await _resolver.ResolveAsync(
                AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
                ModelTypes.Asr,
                ct: CancellationToken.None);
            var candidates = LiveAsrCandidatePolicy.Select(plan);
            var batchCandidates = LiveAsrBatchFallbackService.SelectBatchCandidates(plan);
            frames = Channel.CreateBounded<LiveAsrAudioFrame>(new BoundedChannelOptions(100)
            {
                SingleReader = true,
                SingleWriter = true,
                FullMode = BoundedChannelFullMode.Wait,
            });
            // 备用预览最多保存最近一分钟 PCM，不能反向阻塞浏览器。完整性由
            // BatchFallback 校验；前缀被淘汰时不输出完成终态，交完整文件校准。
            batchFrames = Channel.CreateBounded<LiveAsrAudioFrame>(new BoundedChannelOptions(601)
            {
                SingleReader = true,
                SingleWriter = true,
                FullMode = BoundedChannelFullMode.DropOldest,
            });
            receiveTask = transport.ReceiveFramesAsync(
                [frames.Writer, batchFrames.Writer],
                emit,
                receiveCancellation.Token);

            if (candidates.Count == 0)
            {
                if (batchCandidates.Count > 0)
                {
                    var drainPrimaryTask = DrainFramesAsync(frames.Reader);
                    var batchResult = await _batchFallback.TranscribeAsync(
                        batchCandidates,
                        batchFrames.Reader,
                        emit,
                        onUpstreamRequest,
                        requestContext);
                    sessionResult = batchResult;
                    if (!batchResult.Completed)
                    {
                        sessionFailure = batchResult.Error;
                        if (string.IsNullOrWhiteSpace(batchResult.Transcript))
                        {
                            await emit(new LiveAsrEvent
                            {
                                Type = LiveAsrEventTypes.Degraded,
                                Stable = false,
                                Provider = batchResult.Provider,
                                Model = batchResult.Model,
                                ErrorCode = "LIVE_ASR_BATCH_FALLBACK_FAILED",
                                Message = "备用实时转写失败，录音仍在安全保存，结束后将自动批量校准",
                            });
                        }
                    }
                    await Task.WhenAll(receiveTask, drainPrimaryTask);
                    return new LiveAsrOrchestrationResult(sessionResult, sessionFailure);
                }

                await emit(new LiveAsrEvent
                {
                    Type = LiveAsrEventTypes.Degraded,
                    ErrorCode = "LIVE_ASR_MODEL_UNAVAILABLE",
                    Message = plan.ErrorMessage
                        ?? "模型池没有可用的实时 ASR 方案，录音结束后将自动批量转写",
                });
                sessionFailure = plan.ErrorMessage
                    ?? "模型池没有可用的实时 ASR 方案";
                await Task.WhenAll(
                    receiveTask,
                    DrainFramesAsync(frames.Reader),
                    DrainFramesAsync(batchFrames.Reader));
                return new LiveAsrOrchestrationResult(sessionResult, sessionFailure);
            }

            LiveAsrSessionResult? finalResult = null;
            for (var index = 0; index < candidates.Count; index++)
            {
                var candidate = candidates[index];
                await emit(new LiveAsrEvent
                {
                    Type = LiveAsrEventTypes.Status,
                    Message = candidates.Count > 1
                        ? $"正在连接实时转写方案 {index + 1}/{candidates.Count}"
                        : "正在连接实时转写",
                    Provider = candidate.ActualPlatformName,
                    Model = candidate.ActualModel,
                    Attempt = index + 1,
                    TotalAttempts = candidates.Count,
                });

                var (appKey, accessKey) = SplitApiKey(
                    candidate.ApiKey,
                    candidate.ExchangeTransformerConfig);
                if (string.IsNullOrWhiteSpace(accessKey))
                {
                    finalResult = new LiveAsrSessionResult
                    {
                        Degraded = true,
                        Provider = candidate.ActualPlatformName,
                        Model = candidate.ActualModel,
                        Error = "实时 ASR 凭据缺失",
                    };
                }
                else
                {
                    onUpstreamRequest();
                    finalResult = await _asr.TranscribeLivePcmAsync(
                        ResolveWebSocketUrl(candidate),
                        appKey,
                        accessKey,
                        frames.Reader,
                        emit,
                        candidate.ActualPlatformName,
                        candidate.ActualModel,
                        index + 1,
                        candidates.Count,
                        candidate.ExchangeTransformerConfig,
                        CancellationToken.None,
                        requirePublicPinnedWebSocket: true);
                }

                finalResult = await PreserveResultAndRecordHealthBestEffortAsync(
                    candidate,
                    finalResult);
                if (finalResult.Completed)
                    break;

                // 一次性音频通道只能在候选尚未消费 PCM 时切换。
                if (!LiveAsrCandidatePolicy.CanTryNextCandidate(finalResult))
                    break;
            }

            if (finalResult is null || !finalResult.Completed)
            {
                if (string.IsNullOrWhiteSpace(finalResult?.Transcript) && batchCandidates.Count > 0)
                {
                    var drainPrimaryTask = DrainFramesAsync(frames.Reader);
                    finalResult = await _batchFallback.TranscribeAsync(
                        batchCandidates,
                        batchFrames.Reader,
                        emit,
                        onUpstreamRequest,
                        requestContext);
                    sessionResult = finalResult;
                    await Task.WhenAll(receiveTask, drainPrimaryTask);
                    if (finalResult.Completed)
                        return new LiveAsrOrchestrationResult(sessionResult, sessionFailure);
                    if (!string.IsNullOrWhiteSpace(finalResult.Transcript))
                    {
                        sessionFailure = finalResult.Error ?? "备用实时预览需要完整音频校准";
                        return new LiveAsrOrchestrationResult(sessionResult, sessionFailure);
                    }
                }

                await emit(new LiveAsrEvent
                {
                    Type = LiveAsrEventTypes.Degraded,
                    Text = finalResult?.Transcript,
                    Stable = false,
                    Provider = finalResult?.Provider,
                    Model = finalResult?.Model,
                    ErrorCode = "LIVE_ASR_DEGRADED",
                    Message = "实时转写已降级，录音仍在安全保存，结束后将自动批量转写",
                });
                sessionResult = finalResult;
                sessionFailure = finalResult?.Error ?? "实时转写已降级";
                await Task.WhenAll(
                    receiveTask,
                    DrainFramesAsync(frames.Reader),
                    DrainFramesAsync(batchFrames.Reader));
                return new LiveAsrOrchestrationResult(sessionResult, sessionFailure);
            }

            await receiveTask;
            sessionResult = finalResult;
        }
        catch (Exception ex)
        {
            sessionFailure = ex.Message;
            _logger.LogWarning(ex, "实时 ASR 会话编排异常");
            receiveCancellation.Cancel();
            frames?.Writer.TryComplete();
            batchFrames?.Writer.TryComplete();
            if (receiveTask is not null)
            {
                try
                {
                    await receiveTask;
                }
                catch (OperationCanceledException) when (receiveCancellation.IsCancellationRequested)
                {
                    // 异常收尾主动取消接收，确保 WebSocket 和有界通道不再持有后台任务。
                }
                catch (ChannelClosedException)
                {
                    // 双通道已主动关闭，阻塞中的写入会以 ChannelClosedException 结束。
                }
                catch (Exception receiveEx)
                {
                    _logger.LogDebug(receiveEx, "实时 ASR 接收任务在异常收尾时退出");
                }
            }
            await emit(new LiveAsrEvent
            {
                Type = LiveAsrEventTypes.Degraded,
                ErrorCode = "LIVE_ASR_GATEWAY_FAILED",
                Message = "实时转写连接异常，录音仍在安全保存，结束后将自动批量转写",
            });
        }

        return new LiveAsrOrchestrationResult(sessionResult, sessionFailure);
    }

    internal async Task<LiveAsrSessionResult> PreserveResultAndRecordHealthBestEffortAsync(
        ModelResolutionResult candidate,
        LiveAsrSessionResult result)
    {
        try
        {
            if (result.Completed)
                await _resolver.RecordSuccessAsync(candidate, CancellationToken.None);
            else
                await _resolver.RecordFailureAsync(candidate, CancellationToken.None);
        }
        catch (Exception ex)
        {
            // 健康度是后置观测数据，不能反向改变已经得到的 ASR 业务结果。
            _logger.LogWarning(
                ex,
                "实时 ASR 候选健康度写入失败 resultCompleted={ResultCompleted} candidate={Candidate}",
                result.Completed,
                candidate.ActualModel);
        }

        return result;
    }

    private static async Task DrainFramesAsync(ChannelReader<LiveAsrAudioFrame> reader)
    {
        await foreach (var _ in reader.ReadAllAsync(CancellationToken.None))
        {
            // 音频文件由 MAP 持久化；此处只释放实时 PCM 背压。
        }
    }

    private static string ResolveWebSocketUrl(ModelResolutionResult resolution)
    {
        if (resolution.ExchangeTransformerConfig?.TryGetValue("wsUrl", out var configured) == true
            && !string.IsNullOrWhiteSpace(configured?.ToString()))
        {
            return configured.ToString()!;
        }
        return !string.IsNullOrWhiteSpace(resolution.ApiUrl)
            ? resolution.ApiUrl!
            : "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
    }

    private static (string AppKey, string AccessKey) SplitApiKey(
        string? apiKey,
        Dictionary<string, object>? config)
    {
        var configuredAppKey = config?.GetValueOrDefault("appKey")?.ToString() ?? string.Empty;
        var raw = apiKey ?? string.Empty;
        if (!raw.Contains('|', StringComparison.Ordinal))
            return (configuredAppKey, raw);
        var parts = raw.Split('|', 2);
        return (parts[0], parts[1]);
    }
}
