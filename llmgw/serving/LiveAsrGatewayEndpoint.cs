using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Asr;

namespace PrdAgent.LlmGatewayHost;

/// <summary>
/// 实时 ASR WebSocket 宿主适配器。这里只处理 HTTP 治理、WebSocket 编解码、
/// 请求日志与 DI；模型解析、候选切换和通道生命周期由基础设施编排器负责。
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

        var admission = await GatewayHttpEndpoints.AdmitSpecializedRequestAsync(
            http,
            AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
            ModelTypes.Asr,
            "gw-native",
            CancellationToken.None);
        if (admission is null)
            return;

        var contextAccessor = http.RequestServices.GetRequiredService<ILLMRequestContextAccessor>();
        using var requestContextScope = GatewayHttpEndpoints.OpenContextScope(
            contextAccessor,
            admission.Ingress.Context,
            admission.Ingress.RequestType,
            admission.Ingress.AppCallerCode);
        var orchestrator = http.RequestServices.GetRequiredService<LiveAsrSessionOrchestrator>();
        var logWriter = http.RequestServices.GetRequiredService<ILlmRequestLogWriter>();
        using var socket = await http.WebSockets.AcceptWebSocketAsync();
        using var writeLock = new SemaphoreSlim(1, 1);
        var startedAt = DateTime.UtcNow;
        var stopwatch = Stopwatch.StartNew();
        var logId = await logWriter.StartAsync(
            CreateLiveAsrLogStart(admission, startedAt),
            CancellationToken.None);
        var firstByteRecorded = 0;
        var paidUpstreamAttempted = 0;
        LiveAsrOrchestrationResult outcome = new(null, "实时转写会话未执行");

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
                    if (!string.IsNullOrWhiteSpace(evt.Text)
                        && Interlocked.Exchange(ref firstByteRecorded, 1) == 0
                        && !string.IsNullOrWhiteSpace(logId))
                    {
                        logWriter.MarkFirstByte(logId, DateTime.UtcNow);
                    }
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
            outcome = await orchestrator.ExecuteAsync(
                new WebSocketLiveAsrTransport(socket),
                admission.Ingress.Context
                    ?? throw new InvalidOperationException("实时 ASR 缺少已验证请求上下文"),
                EmitAsync,
                () => Interlocked.Exchange(ref paidUpstreamAttempted, 1));
        }
        finally
        {
            stopwatch.Stop();
            // WebSocket 握手固定为 101；只有编排器实际尝试付费上游才结算预算。
            http.Items[GatewayBudgetCoordinator.HttpContextFinalStatusCodeKey] =
                Volatile.Read(ref paidUpstreamAttempted) == 1
                    ? StatusCodes.Status200OK
                    : StatusCodes.Status400BadRequest;
            if (!string.IsNullOrWhiteSpace(logId))
            {
                if (outcome.Failure is null && outcome.SessionResult?.Completed == true)
                {
                    var result = outcome.SessionResult;
                    logWriter.MarkDone(logId, new LlmLogDone(
                        StatusCode: StatusCodes.Status200OK,
                        ResponseHeaders: null,
                        InputTokens: null,
                        OutputTokens: null,
                        CacheCreationInputTokens: null,
                        CacheReadInputTokens: null,
                        TokenUsageSource: "missing",
                        ImageSuccessCount: null,
                        AnswerText: result.Transcript,
                        ThinkingText: null,
                        AssembledTextChars: result.Transcript?.Length,
                        AssembledTextHash: null,
                        Status: "succeeded",
                        EndedAt: DateTime.UtcNow,
                        DurationMs: stopwatch.ElapsedMilliseconds,
                        FinishReason: "stop",
                        Provider: result.Provider,
                        Model: result.Model));
                }
                else
                {
                    logWriter.MarkError(
                        logId,
                        outcome.Failure
                            ?? outcome.SessionResult?.Error
                            ?? "实时转写未完成，已交由完整录音校准",
                        StatusCodes.Status502BadGateway);
                }
            }
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

    private static LlmLogStart CreateLiveAsrLogStart(
        GatewaySpecializedAdmission admission,
        DateTime startedAt)
        => new(
            RequestId: admission.RequestId,
            Provider: "gateway-live-asr",
            Model: "auto",
            ApiBase: null,
            Path: "/gw/v1/asr/live",
            HttpMethod: "GET",
            RequestHeadersRedacted: null,
            RequestBodyRedacted: "{}",
            RequestBodyHash: null,
            QuestionText: null,
            SystemPromptChars: null,
            SystemPromptHash: null,
            SystemPromptText: null,
            MessageCount: null,
            GroupId: null,
            SessionId: null,
            UserId: admission.Ingress.Context?.UserId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            UserPromptChars: null,
            StartedAt: startedAt,
            RequestType: admission.Ingress.RequestType,
            AppCallerCode: admission.Ingress.AppCallerCode,
            IsStreaming: true,
            GatewayTransport: GatewayTransports.Http,
            ParameterPolicy: admission.Ingress.ParameterPolicy,
            SourceSystem: admission.Ingress.SourceSystem,
            IngressProtocol: admission.Ingress.IngressProtocol,
            AppCallerTitle: admission.Ingress.AppCallerTitle,
            ModelPolicy: admission.Ingress.ModelPolicy,
            TenantId: admission.Authorization.TenantId,
            TeamId: admission.Authorization.TeamId,
            ServiceKeyId: admission.Authorization.KeyId,
            ClientCode: admission.Authorization.ClientCode,
            Environment: admission.Authorization.Environment,
            ServiceKeyPrefix: admission.Authorization.KeyPrefixSnapshot);

    private sealed class WebSocketLiveAsrTransport : ILiveAsrSessionTransport
    {
        private readonly WebSocket _socket;

        public WebSocketLiveAsrTransport(WebSocket socket)
        {
            _socket = socket;
        }

        public async Task<bool> ReceiveStartAsync()
        {
            var message = await ReceiveMessageAsync(
                _socket,
                LiveAsrWireProtocol.MaxPcmBytesPerFrame);
            if (message.Type != WebSocketMessageType.Text)
                return false;
            try
            {
                var control = JsonSerializer.Deserialize<LiveAsrControlMessage>(
                    message.Payload,
                    WireJson);
                return control is
                {
                    Type: "start",
                    SampleRate: 16000,
                    Channels: 1,
                    BitsPerSample: 16,
                };
            }
            catch (JsonException)
            {
                return false;
            }
        }

        public async Task ReceiveFramesAsync(
            IReadOnlyList<ChannelWriter<LiveAsrAudioFrame>> writers,
            Func<LiveAsrEvent, Task> emit,
            CancellationToken cancellationToken)
        {
            long previousSequence = 0;
            try
            {
                while (_socket.State == WebSocketState.Open)
                {
                    var message = await ReceiveMessageAsync(
                        _socket,
                        LiveAsrWireProtocol.MaxPcmBytesPerFrame
                        + LiveAsrWireProtocol.SequencePrefixBytes,
                        cancellationToken);
                    if (message.Type == WebSocketMessageType.Close)
                        break;

                    if (message.Type == WebSocketMessageType.Text)
                    {
                        var control = JsonSerializer.Deserialize<LiveAsrControlMessage>(
                            message.Payload,
                            WireJson);
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
                    foreach (var writer in writers)
                        await writer.WriteAsync(frame, cancellationToken);
                }
            }
            finally
            {
                var finalFrame = new LiveAsrAudioFrame(
                    previousSequence + 1,
                    Array.Empty<byte>(),
                    IsFinal: true);
                foreach (var writer in writers)
                {
                    if (!cancellationToken.IsCancellationRequested)
                    {
                        try
                        {
                            await writer.WriteAsync(finalFrame, cancellationToken);
                        }
                        catch (ChannelClosedException)
                        {
                            // 编排器异常收尾时可能先关闭通道；此时只需完成剩余 writer。
                        }
                    }
                    writer.TryComplete();
                }
            }
        }
    }

    private static async Task<(WebSocketMessageType Type, byte[] Payload)> ReceiveMessageAsync(
        WebSocket socket,
        int maxBytes,
        CancellationToken cancellationToken = default)
    {
        using var stream = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
                return (WebSocketMessageType.Close, Array.Empty<byte>());
            if (stream.Length + result.Count > maxBytes)
                throw new InvalidOperationException("实时 ASR 消息超过允许大小");
            stream.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
                return (result.MessageType, stream.ToArray());
        }
    }
}
