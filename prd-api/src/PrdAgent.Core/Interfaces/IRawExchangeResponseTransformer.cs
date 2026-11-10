using System.Text.Json.Nodes;

namespace PrdAgent.Core.Interfaces;

public static class GatewaySpeechResponseLimits
{
    public const int MaxAudioBytes = 32 * 1024 * 1024;
}

/// <summary>
/// Exchange 的 HTTP 响应不是单个 JSON 对象时使用此契约。
/// 例如豆包 TTS 逐行返回 JSON 音频分片，必须确认终结成功码后才能拼成成品。
/// AuditSummary 只含有界、脱敏的响应事实，禁止把媒体 base64 带入日志。
/// </summary>
public interface IRawExchangeResponseTransformer : IExchangeTransformer
{
    int MaxResponseBytes { get; }

    ExchangeRawResponse TransformRawResponse(
        ReadOnlyMemory<byte> rawResponse,
        string? contentType,
        JsonObject standardRequest,
        Dictionary<string, object>? config);
}

public sealed record ExchangeRawResponse(
    bool Success,
    string AuditSummary,
    byte[]? BinaryContent = null,
    string? ContentType = null,
    string? ErrorCode = null,
    string? ErrorMessage = null);
