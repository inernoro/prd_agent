using System.Globalization;

namespace PrdAgent.Api.Services;

public sealed record VideoExportClipSource(
    string FilePath,
    double DurationSeconds,
    bool HasAudio,
    double TrimStartSeconds = 0,
    double TrimEndSeconds = 0,
    string? Transition = null);

public sealed record VideoExportAudioSource(
    string FilePath,
    double StartSeconds,
    double DurationSeconds,
    double TrimStartSeconds = 0,
    double TrimEndSeconds = 0,
    double Volume = 1);

/// <summary>构建项目时间线合成所需的 ffmpeg 参数。</summary>
public static class VideoExportCommandBuilder
{
    public static IReadOnlyList<string> Build(
        IReadOnlyList<string> inputFiles,
        string outputFile,
        string? aspectRatio) => Build(
            inputFiles.Select(path => new VideoExportClipSource(path, 5, false)).ToList(),
            [],
            null,
            outputFile,
            aspectRatio);

    public static IReadOnlyList<string> Build(
        IReadOnlyList<VideoExportClipSource> videoClips,
        IReadOnlyList<VideoExportAudioSource> audioClips,
        string? subtitleFile,
        string outputFile,
        string? aspectRatio,
        string? fontDirectory = null)
    {
        if (videoClips.Count == 0) throw new ArgumentException("至少需要一个分镜文件", nameof(videoClips));
        foreach (var clip in videoClips)
            ValidateTiming(clip.DurationSeconds, clip.TrimStartSeconds, clip.TrimEndSeconds, "视频");
        foreach (var clip in audioClips)
        {
            ValidateTiming(clip.DurationSeconds, clip.TrimStartSeconds, clip.TrimEndSeconds, "音频");
            if (!double.IsFinite(clip.StartSeconds) || clip.StartSeconds < 0 || !double.IsFinite(clip.Volume))
                throw new ArgumentException("音频的开始时间和音量必须是有效数值", nameof(audioClips));
        }
        var videoDuration = videoClips.Sum(clip => clip.DurationSeconds - clip.TrimStartSeconds - clip.TrimEndSeconds);
        var audioEnd = audioClips.Count == 0 ? 0 : audioClips.Max(clip =>
            clip.StartSeconds + clip.DurationSeconds - clip.TrimStartSeconds - clip.TrimEndSeconds);
        // 容许音频编码器的末帧舍入，同时补足画面，不能通过截断旁白掩盖越界。
        if (audioEnd > videoDuration + 0.05)
            throw new ArgumentException("音频超出画面时长，请延长镜头或缩短配音后重新导出", nameof(audioClips));
        var tailPadding = Math.Ceiling(Math.Max(0, audioEnd - videoDuration) * 30) / 30;
        var (width, height) = GetDimensions(aspectRatio);
        var filters = new List<string>();
        var concatInputs = new List<string>();

        for (var index = 0; index < videoClips.Count; index++)
        {
            var clip = videoClips[index];
            var start = Math.Max(0, clip.TrimStartSeconds);
            var end = clip.DurationSeconds - clip.TrimEndSeconds;
            var effectiveDuration = end - start;
            var clipTailPadding = index == videoClips.Count - 1 ? tailPadding : 0;
            var outputDuration = effectiveDuration + clipTailPadding;
            var videoFilter = $"[{index}:v]trim=start={Number(start)}:end={Number(end)},setpts=PTS-STARTPTS," +
                              $"scale={width}:{height}:force_original_aspect_ratio=decrease," +
                              $"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black," +
                              "setsar=1,fps=30,format=yuv420p";
            if (clipTailPadding > 0)
                videoFilter += $",tpad=stop_mode=clone:stop_duration={Number(clipTailPadding)}";
            if (string.Equals(clip.Transition, "fade", StringComparison.OrdinalIgnoreCase))
            {
                var fadeOutStart = Math.Max(0, effectiveDuration - 0.25);
                videoFilter += $",fade=t=in:st=0:d=0.25,fade=t=out:st={Number(fadeOutStart)}:d=0.25";
            }
            filters.Add(videoFilter + $"[v{index}]");

            if (clip.HasAudio)
            {
                filters.Add($"[{index}:a]atrim=start={Number(start)}:end={Number(end)}," +
                            $"asetpts=PTS-STARTPTS,aresample=48000," +
                            $"aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=duration={Number(outputDuration)}[a{index}]");
            }
            else
            {
                filters.Add($"anullsrc=r=48000:cl=stereo,atrim=duration={Number(outputDuration)}," +
                            $"asetpts=PTS-STARTPTS[a{index}]");
            }
            concatInputs.Add($"[v{index}][a{index}]");
        }

        filters.Add($"{string.Concat(concatInputs)}concat=n={videoClips.Count}:v=1:a=1[basev][basea]");
        var mixedAudioInputs = new List<string> { "[basea]" };
        for (var index = 0; index < audioClips.Count; index++)
        {
            var inputIndex = videoClips.Count + index;
            var clip = audioClips[index];
            var trimStart = Math.Max(0, clip.TrimStartSeconds);
            var duration = clip.DurationSeconds - trimStart - clip.TrimEndSeconds;
            var delay = (int)Math.Round(Math.Max(0, clip.StartSeconds) * 1000);
            filters.Add($"[{inputIndex}:a]atrim=start={Number(trimStart)}:duration={Number(duration)}," +
                        $"asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo," +
                        $"volume={Number(Math.Clamp(clip.Volume, 0, 4))},adelay={delay}|{delay}[mix{index}]");
            mixedAudioInputs.Add($"[mix{index}]");
        }
        filters.Add(audioClips.Count == 0
            ? "[basea]anull[outa]"
            : $"{string.Concat(mixedAudioInputs)}amix=inputs={mixedAudioInputs.Count}:duration=longest:dropout_transition=2:normalize=0[outa]");

        var args = new List<string> { "-y" };
        foreach (var clip in videoClips)
        {
            args.Add("-i");
            args.Add(clip.FilePath);
        }
        foreach (var clip in audioClips)
        {
            args.Add("-i");
            args.Add(clip.FilePath);
        }
        var subtitleInputIndex = videoClips.Count + audioClips.Count;
        if (!string.IsNullOrWhiteSpace(subtitleFile))
        {
            args.Add("-i");
            args.Add(subtitleFile);
        }

        var videoOutput = "[basev]";
        if (!string.IsNullOrWhiteSpace(subtitleFile))
        {
            // 浏览器和常见短视频播放器不自动显示 MP4 的 mov_text 轨道；同步烧录保证所见即所得。
            var subtitleFilter = $"[basev]subtitles=filename={EscapeFilterValue(subtitleFile)}";
            if (fontDirectory != null)
            {
                if (!File.Exists(Path.Combine(fontDirectory, "default.ttf")))
                    throw new InvalidOperationException("中文字幕字体不可用，请联系管理员恢复字体后重新导出");
                subtitleFilter += $":fontsdir={EscapeFilterValue(fontDirectory)}:force_style=FontName=Zhuque Fangsong (technical preview)";
            }
            filters.Add(subtitleFilter + "[outv]");
            videoOutput = "[outv]";
        }
        args.AddRange([
            "-filter_complex", string.Join(";", filters),
            "-map", videoOutput,
            "-map", "[outa]",
        ]);
        if (!string.IsNullOrWhiteSpace(subtitleFile))
        {
            args.Add("-map");
            args.Add($"{subtitleInputIndex}:s:0");
        }
        args.AddRange([
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "20",
            "-c:a", "aac",
            "-b:a", "192k",
        ]);
        if (!string.IsNullOrWhiteSpace(subtitleFile))
        {
            args.Add("-c:s");
            args.Add("mov_text");
        }
        args.AddRange(["-movflags", "+faststart", outputFile]);
        return args;
    }

    public static (int Width, int Height) GetDimensions(string? aspectRatio) => aspectRatio switch
    {
        "9:16" => (720, 1280),
        "1:1" => (720, 720),
        "4:3" => (960, 720),
        "3:4" => (720, 960),
        "21:9" => (1260, 540),
        "9:21" => (540, 1260),
        _ => (1280, 720),
    };

    private static void ValidateTiming(double duration, double trimStart, double trimEnd, string label)
    {
        if (!double.IsFinite(duration) || !double.IsFinite(trimStart) || !double.IsFinite(trimEnd)
            || duration <= 0 || trimStart < 0 || trimEnd < 0 || trimStart + trimEnd >= duration)
            throw new ArgumentException($"{label}时长或裁剪范围无效，请调整后重新导出");
    }

    private static string EscapeFilterValue(string value)
    {
        // filename 选项和 filter graph 各自解析一轮反斜杠，且参数直接走 ArgumentList，无 shell。
        var option = value.Replace("\\", "\\\\").Replace(":", "\\:").Replace("'", "\\'");
        return option.Replace("\\", "\\\\").Replace("'", "\\'")
            .Replace("[", "\\[").Replace("]", "\\]").Replace(";", "\\;").Replace(",", "\\,");
    }

    private static string Number(double value) => value.ToString("0.###", CultureInfo.InvariantCulture);
}
