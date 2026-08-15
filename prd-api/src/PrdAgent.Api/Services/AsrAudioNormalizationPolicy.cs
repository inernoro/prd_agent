using System.Collections.ObjectModel;
using System.Buffers.Binary;
using System.Text;
using PrdAgent.Infrastructure.LlmGateway.Asr;

namespace PrdAgent.Api.Services;

/// <summary>
/// ASR 输入音频的统一 ffmpeg 规范化参数。
/// 短录音补尾部静音到 15 秒，避免 Whisper 兼容服务对 5 秒左右的清晰人声稳定误判为无语音。
/// 补白只发生在音频末尾，不改变原始人声及其时间戳；长音频不会被截断或额外补白。
/// </summary>
internal static class AsrAudioNormalizationPolicy
{
    internal const int MinimumDurationSeconds = 15;
    internal const string ShortClipPaddingFilter = "apad=whole_dur=15";
    internal const int NormalizedSampleRate = 16000;
    internal const int NormalizedBytesPerSample = 2;
    internal const long MaxNormalizedAudioBytes = 64L * 1024 * 1024;
    internal static double MaxNormalizedDurationSeconds =>
        (MaxNormalizedAudioBytes - 44d) / (NormalizedSampleRate * NormalizedBytesPerSample);
    internal static bool IsNormalizedAudioWithinLimit(long length) =>
        length >= 0 && length < MaxNormalizedAudioBytes;

    /// <summary>
    /// 对 ffmpeg 产出的 PCM16 单声道 WAV 做确定性无人声门禁。只有成功解析规范格式且
    /// 整段未达到既有实时 ASR 的人声幅度门槛时才返回 true；格式异常时 fail-open，
    /// 交给后续 ASR 返回可诊断错误，避免误杀有效录音。
    /// </summary>
    internal static bool IsDefinitelySilentNormalizedWave(byte[] wave)
    {
        if (!TryReadNormalizedPcm(wave, out var pcm))
            return false;
        // 实时门槛的 1% 活跃样本比例只适用于 5 秒窗口，不能对整段录音一次计算：
        // 10 分钟录音中 5 秒真实发言只占 0.83%，整段计算会把它误杀为静音。
        // 逐窗检查，只要任一窗口有人声就放行；尾窗也按自身长度计算。
        var windowBytes = LiveAsrBatchFallbackService.WindowBytes;
        for (var offset = 0; offset < pcm.Length; offset += windowBytes)
        {
            var count = Math.Min(windowBytes, pcm.Length - offset);
            if (LiveAsrBatchFallbackService.HasLikelySpeech(pcm.AsSpan(offset, count)))
                return false;
        }
        return true;
    }

    private static bool TryReadNormalizedPcm(byte[] wave, out byte[] pcm)
    {
        pcm = [];
        if (wave.Length < 44
            || Encoding.ASCII.GetString(wave, 0, 4) != "RIFF"
            || Encoding.ASCII.GetString(wave, 8, 4) != "WAVE")
            return false;

        ushort format = 0;
        ushort channels = 0;
        ushort bitsPerSample = 0;
        var sampleRate = 0;
        var offset = 12;
        while (offset + 8 <= wave.Length)
        {
            var chunkSize = BinaryPrimitives.ReadInt32LittleEndian(wave.AsSpan(offset + 4, 4));
            if (chunkSize < 0 || offset + 8L + chunkSize > wave.Length)
                return false;
            var chunkId = Encoding.ASCII.GetString(wave, offset, 4);
            var content = wave.AsSpan(offset + 8, chunkSize);
            if (chunkId == "fmt " && chunkSize >= 16)
            {
                format = BinaryPrimitives.ReadUInt16LittleEndian(content[..2]);
                channels = BinaryPrimitives.ReadUInt16LittleEndian(content.Slice(2, 2));
                sampleRate = BinaryPrimitives.ReadInt32LittleEndian(content.Slice(4, 4));
                bitsPerSample = BinaryPrimitives.ReadUInt16LittleEndian(content.Slice(14, 2));
            }
            else if (chunkId == "data")
            {
                pcm = content.ToArray();
            }
            offset += 8 + chunkSize + (chunkSize & 1);
        }

        return format == 1
            && channels == 1
            && bitsPerSample == 16
            && sampleRate == NormalizedSampleRate
            && pcm.Length >= NormalizedBytesPerSample;
    }

    internal static void ConfigureFfmpegArguments(
        Collection<string> arguments,
        string inputPath,
        string outputPath)
    {
        string[] values =
        {
            "-y", "-i", inputPath,
            "-vn",
            "-af", ShortClipPaddingFilter,
            "-ac", "1",
            "-ar", "16000",
            "-acodec", "pcm_s16le",
        };
        foreach (var value in values)
            arguments.Add(value);
        arguments.Add(outputPath);
    }
}
