using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway.Asr;

namespace PrdAgent.Api.Services;

public sealed class DocumentStoreLiveTranscriptionRelay
{
    private static readonly JsonSerializerOptions WireJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly IConfiguration _configuration;
    private readonly ILogger<DocumentStoreLiveTranscriptionRelay> _logger;

    public DocumentStoreLiveTranscriptionRelay(
        IConfiguration configuration,
        ILogger<DocumentStoreLiveTranscriptionRelay> logger)
    {
        _configuration = configuration;
        _logger = logger;
    }

    public async Task<LiveAsrSessionResult> RelayAsync(WebSocket browser, string userId, string sessionId)
    {
        var baseUrl = (_configuration["LlmGateway:ServeBaseUrl"] ?? "http://llmgw-serve:8091").TrimEnd('/');
        var uriBuilder = new UriBuilder($"{baseUrl}/gw/v1/asr/live")
        {
            Scheme = baseUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws",
        };

        using var gateway = new ClientWebSocket();
        gateway.Options.SetRequestHeader("X-Gateway-Key", _configuration["LlmGwServe:ApiKey"] ?? string.Empty);
        gateway.Options.SetRequestHeader("X-Gateway-Source", "map");
        gateway.Options.SetRequestHeader(
            "X-Gateway-App-Caller",
            AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio);
        gateway.Options.SetRequestHeader("X-Gateway-User-Id", userId);
        gateway.Options.SetRequestHeader("X-Request-Id", $"live-asr-{sessionId}");

        var latest = new LiveAsrSessionResult { Degraded = true, Error = "实时转写未启动" };
        try
        {
            await gateway.ConnectAsync(uriBuilder.Uri, CancellationToken.None);
            await SendTextAsync(gateway, new LiveAsrControlMessage { Type = "start" });

            var browserToGateway = PumpBrowserToGatewayAsync(browser, gateway);
            var gatewayToBrowser = PumpGatewayToBrowserAsync(
                gateway,
                browser,
                evt =>
                {
                    latest = new LiveAsrSessionResult
                    {
                        Completed = evt.Type == LiveAsrEventTypes.Final && !string.IsNullOrWhiteSpace(evt.Text),
                        Degraded = evt.Type is LiveAsrEventTypes.Degraded or LiveAsrEventTypes.Error,
                        Transcript = evt.Text ?? latest.Transcript,
                        Provider = evt.Provider ?? latest.Provider,
                        Model = evt.Model ?? latest.Model,
                        Error = evt.Type is LiveAsrEventTypes.Degraded or LiveAsrEventTypes.Error
                            ? evt.Message
                            : null,
                    };
                });
            await Task.WhenAll(browserToGateway, gatewayToBrowser);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "[document-store] 实时转写中继失败 sessionId={SessionId} userId={UserId}",
                sessionId,
                userId);
            latest = new LiveAsrSessionResult
            {
                Completed = false,
                Degraded = true,
                Transcript = latest.Transcript,
                Provider = latest.Provider,
                Model = latest.Model,
                Error = "实时转写连接失败，录音结束后将自动批量转写",
            };
            await TrySendBrowserEventAsync(browser, new LiveAsrEvent
            {
                Type = LiveAsrEventTypes.Degraded,
                Text = latest.Transcript,
                ErrorCode = "LIVE_ASR_RELAY_FAILED",
                Message = latest.Error,
            });
        }
        finally
        {
            await TryCloseAsync(gateway, "map-relay-finished");
            await TryCloseAsync(browser, "live-asr-finished");
        }

        return latest;
    }

    private static async Task PumpBrowserToGatewayAsync(WebSocket browser, WebSocket gateway)
    {
        while (browser.State == WebSocketState.Open && gateway.State == WebSocketState.Open)
        {
            var message = await ReceiveMessageAsync(browser);
            if (message.Type == WebSocketMessageType.Close)
            {
                await SendTextAsync(gateway, new LiveAsrControlMessage { Type = "finish" });
                return;
            }

            await gateway.SendAsync(
                message.Payload,
                message.Type,
                endOfMessage: true,
                CancellationToken.None);
            if (message.Type == WebSocketMessageType.Text
                && IsFinish(message.Payload))
            {
                return;
            }
        }
    }

    private static async Task PumpGatewayToBrowserAsync(
        WebSocket gateway,
        WebSocket browser,
        Action<LiveAsrEvent> capture)
    {
        while (gateway.State == WebSocketState.Open)
        {
            var message = await ReceiveMessageAsync(gateway);
            if (message.Type == WebSocketMessageType.Close)
                return;
            if (message.Type != WebSocketMessageType.Text)
                continue;

            try
            {
                var evt = JsonSerializer.Deserialize<LiveAsrEvent>(message.Payload, WireJson);
                if (evt != null)
                    capture(evt);
            }
            catch (JsonException)
            {
                // 原文仍转发给浏览器；持久化只接受统一事件结构。
            }

            if (browser.State == WebSocketState.Open)
            {
                await browser.SendAsync(
                    message.Payload,
                    WebSocketMessageType.Text,
                    endOfMessage: true,
                    CancellationToken.None);
            }
        }
    }

    private static bool IsFinish(byte[] payload)
    {
        try
        {
            return JsonSerializer.Deserialize<LiveAsrControlMessage>(payload, WireJson)?.Type == "finish";
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static async Task SendTextAsync(WebSocket socket, LiveAsrControlMessage control)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(control, WireJson);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
    }

    private static async Task TrySendBrowserEventAsync(WebSocket browser, LiveAsrEvent evt)
    {
        if (browser.State != WebSocketState.Open)
            return;
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(evt, WireJson);
            await browser.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch (WebSocketException)
        {
            // 浏览器已离开。
        }
    }

    private static async Task<(WebSocketMessageType Type, byte[] Payload)> ReceiveMessageAsync(WebSocket socket)
    {
        using var stream = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close)
                return (WebSocketMessageType.Close, Array.Empty<byte>());
            if (stream.Length + result.Count > LiveAsrWireProtocol.MaxPcmBytesPerFrame + 4096)
                throw new InvalidOperationException("实时转写消息超过允许大小");
            stream.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
                return (result.MessageType, stream.ToArray());
        }
    }

    private static async Task TryCloseAsync(WebSocket socket, string description)
    {
        if (socket.State != WebSocketState.Open)
            return;
        try
        {
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, description, CancellationToken.None);
        }
        catch (WebSocketException)
        {
            // 对端已断开。
        }
    }
}
