using System.Collections.ObjectModel;

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
            outputPath,
        };
        foreach (var value in values)
            arguments.Add(value);
    }
}
