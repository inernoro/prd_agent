using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Asr;

namespace PrdAgent.LlmGatewayHost;

/// <summary>
/// 独立网关承载的实时 ASR WebSocket。模型只解析一次，发送阶段仅消费预计算候选。
/// 浏览器不会直连此端点；MAP 使用 scoped gateway key 进行内网中继。
/// </summary>
public static class LiveAsrGatewayEndpoint
{
    private static readonly JsonSerializerOptions WireJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true,
    };

    public static void MapLiveAsrGatewayEndpoint(this WebApplication app)
    {
        app.Map("/gw/v1/asr/live", HandleAsync);
    }

    private static async Task HandleAsync(HttpContext http)
    {
        if (!http.WebSockets.IsWebSocketRequest)
        {
            http.Response.StatusCode = StatusCodes.Status426UpgradeRequired;
            await http.Response.WriteAsJsonAsync(new
            {
                error = new
                {
                    code = "LIVE_ASR_WEBSOCKET_REQUIRED",
                    message = "实时转写端点仅接受 WebSocket",
                },
            }, WireJson);
            return;
        }

        var resolver = http.RequestServices.GetRequiredService<IModelResolver>();
        var asr = http.RequestServices.GetRequiredService<DoubaoStreamAsrService>();
        var logger = http.RequestServices.GetRequiredService<ILoggerFactory>()
            .CreateLogger("LiveAsrGatewayEndpoint");
        using var socket = await http.WebSockets.AcceptWebSocketAsync();
        using var writeLock = new SemaphoreSlim(1, 1);

        async Task EmitAsync(LiveAsrEvent evt)
        {
            if (socket.State != WebSocketState.Open)
                return;
            var bytes = JsonSerializer.SerializeToUtf8Bytes(evt, WireJson);
            await writeLock.WaitAsync(CancellationToken.None);
            try
            {
                if (socket.State == WebSocketState.Open)
                {
                    await socket.SendAsync(
                        bytes,
                        WebSocketMessageType.Text,
                        endOfMessage: true,
                        CancellationToken.None);
                }
            }
            catch (WebSocketException)
            {
                // MAP 中继断开不覆盖上游会话结论。
            }
            finally
            {
                writeLock.Release();
            }
        }

        try
        {
            var start = await ReceiveStartAsync(socket);
            if (start is null)
            {
                await EmitAsync(new LiveAsrEvent
                {
                    Type = LiveAsrEventTypes.Error,
                    ErrorCode = "LIVE_ASR_START_INVALID",
                    Message = "实时转写缺少合法 start 控制消息",
                });
                return;
            }

            var primary = await resolver.ResolveAsync(
                AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
                ModelTypes.Asr,
                ct: CancellationToken.None);
            var candidates = LiveAsrCandidatePolicy.Select(primary);
            if (candidates.Count == 0)
            {
                await EmitAsync(new LiveAsrEvent
                {
                    Type = LiveAsrEventTypes.Degraded,
                    ErrorCode = "LIVE_ASR_MODEL_UNAVAILABLE",
                    Message = primary.ErrorMessage ?? "模型池没有可用的实时 ASR 方案，录音结束后将自动批量转写",
                });
                return;
            }

            var frames = Channel.CreateBounded<LiveAsrAudioFrame>(new BoundedChannelOptions(100)
            {
                SingleReader = true,
                SingleWriter = true,
                FullMode = BoundedChannelFullMode.Wait,
            });
            var receiveTask = ReceiveFramesAsync(socket, frames.Writer, EmitAsync);
            LiveAsrSessionResult? finalResult = null;

            for (var index = 0; index < candidates.Count; index++)
            {
                var candidate = candidates[index];
                await EmitAsync(new LiveAsrEvent
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

                var (appKey, accessKey) = SplitApiKey(candidate.ApiKey, candidate.ExchangeTransformerConfig);
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
                    finalResult = await asr.TranscribeLivePcmAsync(
                        ResolveWebSocketUrl(candidate),
                        appKey,
                        accessKey,
                        frames.Reader,
                        EmitAsync,
                        candidate.ActualPlatformName,
                        candidate.ActualModel,
                        index + 1,
                        candidates.Count,
                        candidate.ExchangeTransformerConfig,
                        CancellationToken.None,
                        requirePublicPinnedWebSocket: true);
                }

                if (finalResult.Completed)
                {
                    await resolver.RecordSuccessAsync(candidate, CancellationToken.None);
                    break;
                }

                await resolver.RecordFailureAsync(candidate, CancellationToken.None);
                // 上游一旦已经返回过文字，继续切换会产生两套时间轴。保留已得到的文字，
                // 将最终校准交给录音文件批处理；只有建立阶段失败才尝试下一个候选。
                if (!string.IsNullOrWhiteSpace(finalResult.Transcript))
                    break;
            }

            if (finalResult is null || !finalResult.Completed)
            {
                await EmitAsync(new LiveAsrEvent
                {
                    Type = LiveAsrEventTypes.Degraded,
                    Text = finalResult?.Transcript,
                    Stable = false,
                    Provider = finalResult?.Provider,
                    Model = finalResult?.Model,
                    ErrorCode = "LIVE_ASR_DEGRADED",
                    Message = "实时转写已降级，录音仍在安全保存，结束后将自动批量转写",
                });
                // 已无可执行候选时仍持续排空浏览器 PCM，直到收到 finish。
                // 否则 bounded channel 填满后会卡住接收循环，MAP 无法正常结束会话并持久化降级状态。
                await Task.WhenAll(receiveTask, DrainFramesAsync(frames.Reader));
                return;
            }

            await receiveTask;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "实时 ASR 网关会话异常");
            await EmitAsync(new LiveAsrEvent
            {
                Type = LiveAsrEventTypes.Degraded,
                ErrorCode = "LIVE_ASR_GATEWAY_FAILED",
                Message = "实时转写连接异常，录音仍在安全保存，结束后将自动批量转写",
            });
        }
        finally
        {
            if (socket.State == WebSocketState.Open)
            {
                try
                {
                    await socket.CloseAsync(
                        WebSocketCloseStatus.NormalClosure,
                        "live-asr-finished",
                        CancellationToken.None);
                }
                catch (WebSocketException)
                {
                    // 对端已离开。
                }
            }
        }
    }

    private static async Task<LiveAsrControlMessage?> ReceiveStartAsync(WebSocket socket)
    {
        var message = await ReceiveMessageAsync(socket, LiveAsrWireProtocol.MaxPcmBytesPerFrame);
        if (message.Type != WebSocketMessageType.Text)
            return null;
        try
        {
            var control = JsonSerializer.Deserialize<LiveAsrControlMessage>(message.Payload, WireJson);
            return control is
            {
                Type: "start",
                SampleRate: 16000,
                Channels: 1,
                BitsPerSample: 16,
            }
                ? control
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static async Task ReceiveFramesAsync(
        WebSocket socket,
        ChannelWriter<LiveAsrAudioFrame> writer,
        Func<LiveAsrEvent, Task> emit)
    {
        long previousSequence = 0;
        try
        {
            while (socket.State == WebSocketState.Open)
            {
                var message = await ReceiveMessageAsync(
                    socket,
                    LiveAsrWireProtocol.MaxPcmBytesPerFrame + LiveAsrWireProtocol.SequencePrefixBytes);
                if (message.Type == WebSocketMessageType.Close)
                    break;

                if (message.Type == WebSocketMessageType.Text)
                {
                    var control = JsonSerializer.Deserialize<LiveAsrControlMessage>(message.Payload, WireJson);
                    if (control?.Type == "finish")
                        break;
                    continue;
                }

                if (!LiveAsrWireProtocol.TryDecodeAudioFrame(
                        message.Payload,
                        previousSequence,
                        out var frame,
                        out var error))
                {
                    if (error == "duplicate")
                        continue;
                    await emit(new LiveAsrEvent
                    {
                        Type = LiveAsrEventTypes.Error,
                        ErrorCode = "LIVE_ASR_FRAME_INVALID",
                        Message = error,
                    });
                    break;
                }

                previousSequence = frame!.Sequence;
                await writer.WriteAsync(frame, CancellationToken.None);
            }
        }
        finally
        {
            await writer.WriteAsync(
                new LiveAsrAudioFrame(previousSequence + 1, Array.Empty<byte>(), IsFinal: true),
                CancellationToken.None);
            writer.TryComplete();
        }
    }

    private static async Task DrainFramesAsync(ChannelReader<LiveAsrAudioFrame> reader)
    {
        await foreach (var _ in reader.ReadAllAsync(CancellationToken.None))
        {
            // 录音文件由 MAP 的 MediaRecorder 分片持久化；这里仅释放实时 PCM 背压。
        }
    }

    private static async Task<(WebSocketMessageType Type, byte[] Payload)> ReceiveMessageAsync(
        WebSocket socket,
        int maxBytes)
    {
        using var stream = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close)
                return (WebSocketMessageType.Close, Array.Empty<byte>());
            if (stream.Length + result.Count > maxBytes)
                throw new InvalidOperationException("实时 ASR 消息超过允许大小");
            stream.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
                return (result.MessageType, stream.ToArray());
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
