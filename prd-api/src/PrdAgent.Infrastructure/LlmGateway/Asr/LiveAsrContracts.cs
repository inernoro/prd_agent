using System.Buffers.Binary;
using System.Text.Json.Serialization;

namespace PrdAgent.Infrastructure.LlmGateway.Asr;

/// <summary>
/// 浏览器、MAP 与独立 LLM Gateway 之间的实时 ASR 控制消息。
/// 音频帧本身使用二进制消息传输，前 4 字节为 little-endian 顺序号，之后为 16kHz 单声道 PCM16。
/// </summary>
public sealed class LiveAsrControlMessage
{
    public string Type { get; set; } = string.Empty;
    public int SampleRate { get; set; } = 16000;
    public int Channels { get; set; } = 1;
    public int BitsPerSample { get; set; } = 16;
    public long LastSequence { get; set; }
}

/// <summary>实时 ASR 向下游发送的统一事件。</summary>
public sealed class LiveAsrEvent
{
    public string Type { get; init; } = string.Empty;
    public long Sequence { get; init; }
    public string? Text { get; init; }
    public bool Stable { get; init; }
    public string? Message { get; init; }
    public string? Provider { get; init; }
    public string? Model { get; init; }
    public int Attempt { get; init; }
    public int TotalAttempts { get; init; }
    public string? ErrorCode { get; init; }

    [JsonIgnore]
    public bool IsTerminal => Type is LiveAsrEventTypes.Final or LiveAsrEventTypes.Degraded or LiveAsrEventTypes.Error;
}

public static class LiveAsrEventTypes
{
    public const string Ready = "ready";
    public const string Status = "status";
    public const string Partial = "partial";
    public const string Final = "final";
    public const string Degraded = "degraded";
    public const string Error = "error";
}

/// <summary>已验序的 PCM 帧；Sequence 由浏览器生成并在两级中继中保持不变。</summary>
public sealed record LiveAsrAudioFrame(long Sequence, byte[] Pcm, bool IsFinal = false);

public static class LiveAsrWireProtocol
{
    public const int SequencePrefixBytes = sizeof(int);
    public const int MaxPcmBytesPerFrame = 128 * 1024;

    public static bool TryDecodeAudioFrame(
        ReadOnlySpan<byte> payload,
        long previousSequence,
        out LiveAsrAudioFrame? frame,
        out string? error)
    {
        frame = null;
        error = null;
        if (payload.Length <= SequencePrefixBytes)
        {
            error = "实时音频帧缺少顺序号或 PCM 数据";
            return false;
        }

        var sequence = BinaryPrimitives.ReadInt32LittleEndian(payload[..SequencePrefixBytes]);
        if (sequence <= 0)
        {
            error = "实时音频帧顺序号必须大于 0";
            return false;
        }
        if (sequence <= previousSequence)
        {
            error = "duplicate";
            return false;
        }
        if (sequence != previousSequence + 1)
        {
            error = $"实时音频帧不连续，应收到 {previousSequence + 1}，实际收到 {sequence}";
            return false;
        }

        var pcm = payload[SequencePrefixBytes..];
        if (pcm.Length > MaxPcmBytesPerFrame)
        {
            error = $"实时音频帧不能超过 {MaxPcmBytesPerFrame} 字节";
            return false;
        }
        if ((pcm.Length & 1) != 0)
        {
            error = "PCM16 音频帧字节数必须为偶数";
            return false;
        }

        frame = new LiveAsrAudioFrame(sequence, pcm.ToArray());
        return true;
    }
}

public sealed class LiveAsrSessionResult
{
    public bool Completed { get; init; }
    public bool Degraded { get; init; }
    public string Transcript { get; init; } = string.Empty;
    public string? Provider { get; init; }
    public string? Model { get; init; }
    public string? Error { get; init; }
}

public static class LiveAsrCandidatePolicy
{
    public const int MaxAttempts = 3;
    public const string PreferredModel = "doubao-asr-stream";

    public static List<ModelResolutionResult> Select(params ModelResolutionResult[] resolutions)
    {
        return resolutions
            .Where(resolution => resolution is not null)
            .SelectMany(resolution => new[] { resolution }
                .Concat(resolution.RetryCandidates ?? []))
            .Where(candidate =>
                candidate.Success
                && candidate.IsExchange
                && string.Equals(
                    candidate.ExchangeTransformerType,
                    "doubao-asr-stream",
                    StringComparison.OrdinalIgnoreCase))
            .GroupBy(
                candidate => $"{candidate.ActualPlatformId}::{candidate.ActualModel}",
                StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .Take(MaxAttempts)
            .ToList();
    }
}
