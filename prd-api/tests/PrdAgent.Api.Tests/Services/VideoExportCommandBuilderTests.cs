using System.Diagnostics;
using System.Text.Json;
using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class VideoExportCommandBuilderTests
{
    [Fact]
    public void Build_ShouldNormalizeClipsAndConcatenateInTimelineOrder()
    {
        var args = VideoExportCommandBuilder.Build(
            ["scene-000.mp4", "scene-001.mp4"],
            "export.mp4",
            "9:16");

        args.ShouldContain("scene-000.mp4");
        args.ShouldContain("scene-001.mp4");
        args.ShouldContain("export.mp4");
        var filter = args[args.ToList().IndexOf("-filter_complex") + 1];
        filter.ShouldContain("scale=720:1280");
        filter.ShouldContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[basev][basea]");
        args.ShouldContain("[outa]");
        args.ShouldNotContain("-an");
    }

    [Fact]
    public void Build_ShouldMixTimelineAudioAndEmbedSubtitleTrack()
    {
        var args = VideoExportCommandBuilder.Build(
            [new VideoExportClipSource("scene.mp4", 6, true, 1, 0.5, "fade")],
            [new VideoExportAudioSource("music.mp3", 2, 2.5, Volume: 0.35)],
            "subtitles.srt",
            "export.mp4",
            "16:9");

        var filter = args[args.ToList().IndexOf("-filter_complex") + 1];
        filter.ShouldContain("[0:a]atrim=start=1:end=5.5");
        filter.ShouldContain("adelay=2000|2000");
        filter.ShouldContain("amix=inputs=2:duration=longest");
        filter.ShouldContain("fade=t=in");
        args.ShouldContain("subtitles.srt");
        args.ShouldContain("mov_text");
    }

    [Fact]
    public void Build_ShouldSubtractBothAudioTrimBoundsFromEffectiveDuration()
    {
        var args = VideoExportCommandBuilder.Build(
            [new VideoExportClipSource("scene.mp4", 10, false)],
            [new VideoExportAudioSource("voice.mp3", 0, 10, TrimStartSeconds: 3, TrimEndSeconds: 2)],
            null,
            "export.mp4",
            "16:9");

        var filter = args[args.ToList().IndexOf("-filter_complex") + 1];
        filter.ShouldContain("[1:a]atrim=start=3:duration=5");
    }

    [Theory]
    [InlineData("16:9", 1280, 720)]
    [InlineData("9:16", 720, 1280)]
    [InlineData("1:1", 720, 720)]
    [InlineData("4:3", 960, 720)]
    [InlineData("3:4", 720, 960)]
    public void GetDimensions_ShouldReturnStableExportCanvas(string aspectRatio, int width, int height)
    {
        VideoExportCommandBuilder.GetDimensions(aspectRatio).ShouldBe((width, height));
    }

    [Fact]
    public void Build_ShouldRejectEmptyTimeline()
    {
        Should.Throw<ArgumentException>(() =>
            VideoExportCommandBuilder.Build([], "export.mp4", "16:9"));
    }

    [Fact]
    public void Build_ShouldRejectAudioOutsidePictureWithRecoveryAdvice()
    {
        var error = Should.Throw<ArgumentException>(() => VideoExportCommandBuilder.Build(
            [new VideoExportClipSource("scene.mp4", 3, false)],
            [new VideoExportAudioSource("voice.wav", 2, 1.2)], null, "export.mp4", "16:9"));
        error.Message.ShouldContain("延长镜头或缩短配音");
    }

    [Fact]
    public void Build_ShouldExplainMissingBundledSubtitleFont()
    {
        var error = Should.Throw<InvalidOperationException>(() => VideoExportCommandBuilder.Build(
            [new VideoExportClipSource("scene.mp4", 3, false)], [], "subtitles.srt", "export.mp4", "16:9",
            Path.Combine(Path.GetTempPath(), $"missing-font-{Guid.NewGuid():N}")));
        error.Message.ShouldContain("恢复字体后重新导出");
    }

    [Theory]
    [InlineData(double.NaN, 0, 0)]
    [InlineData(double.PositiveInfinity, 0, 0)]
    [InlineData(1, -1, 0)]
    [InlineData(1, 0.7, 0.3)]
    public void Build_ShouldRejectInvalidTiming(double duration, double start, double end)
    {
        Should.Throw<ArgumentException>(() => VideoExportCommandBuilder.Build(
            [new VideoExportClipSource("scene.mp4", duration, false, start, end)],
            [], null, "export.mp4", "16:9"));
    }

    [Fact]
    public async Task Build_ShouldBurnSynchronizedSubtitlesAndKeepNarrationTailAcrossThreeShotsAndReexport()
    {
        // 特殊字符覆盖 filename 选项和 filter graph 两轮解析；不用 shell。
        var tempDir = Path.Combine(Path.GetTempPath(), $"video-export-test-{Guid.NewGuid():N}'[clips],part:1");
        Directory.CreateDirectory(tempDir);
        try
        {
            var scenes = new List<VideoExportClipSource>();
            var voices = new List<VideoExportAudioSource>();
            var colors = new[] { "red", "green", "blue" };
            for (var index = 0; index < 3; index++)
            {
                var path = Path.Combine(tempDir, $"scene-{index}.mp4");
                var sceneArgs = new List<string>
                {
                    "-y", "-f", "lavfi", "-i", $"color=c={colors[index]}:s=320x180:d=1:r=30",
                };
                // 后两镜带有比画面更短的原始音轨，补静音后仍须保持一秒一镜。
                if (index > 0) sceneArgs.AddRange(["-f", "lavfi", "-i", "sine=frequency=220:duration=0.2", "-c:a", "aac"]);
                sceneArgs.AddRange(["-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
                await RunProcessAsync("ffmpeg", sceneArgs);
                scenes.Add(new VideoExportClipSource(path, 1, index > 0));
                var voicePath = Path.Combine(tempDir, $"voice-{index}.wav");
                var length = index == 2 ? 0.94 : 0.8;
                await RunProcessAsync("ffmpeg", [
                    "-y", "-f", "lavfi", "-i", $"sine=frequency={440 + index * 220}:duration={length.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
                    "-c:a", "pcm_s16le", voicePath,
                ]);
                voices.Add(new VideoExportAudioSource(voicePath, index + 0.1, length));
            }
            var subtitles = Path.Combine(tempDir, "subtitles.srt");
            const string original = "1\n00:00:00,100 --> 00:00:00,900\n第一镜画面\n\n2\n00:00:01,100 --> 00:00:01,900\n第二镜旁白\n\n3\n00:00:02,100 --> 00:00:03,040\n第三镜结尾\n";
            await File.WriteAllTextAsync(subtitles, original);
            var output = Path.Combine(tempDir, "output.mp4");
            var fonts = Path.Combine(AppContext.BaseDirectory, "Assets", "Fonts");
            var renderLog = await RunProcessAsync("ffmpeg", VideoExportCommandBuilder.Build(scenes, voices, subtitles, output, "16:9", fonts), returnErrorOutput: true);
            renderLog.ShouldContain("ZhuqueFangsong");
            renderLog.ShouldNotContain("failed to find any fallback");

            using var probe = JsonDocument.Parse(await RunProcessAsync("ffprobe", [
                "-v", "error", "-show_streams", "-show_format", "-of", "json", output,
            ]));
            var streams = probe.RootElement.GetProperty("streams").EnumerateArray().ToList();
            streams.Select(stream => stream.GetProperty("codec_type").GetString())
                .ShouldBe(new[] { "video", "audio", "subtitle" }, ignoreOrder: true);
            var duration = double.Parse(probe.RootElement.GetProperty("format").GetProperty("duration").GetString()!, System.Globalization.CultureInfo.InvariantCulture);
            duration.ShouldBeInRange(3.04, 3.2);
            var audioDuration = double.Parse(streams.Single(stream => stream.GetProperty("codec_type").GetString() == "audio")
                .GetProperty("duration").GetString()!, System.Globalization.CultureInfo.InvariantCulture);
            audioDuration.ShouldBeGreaterThanOrEqualTo(3.06);
            var subtitleText = await RunProcessAsync("ffmpeg", ["-v", "error", "-i", output, "-map", "0:s:0", "-f", "srt", "-"]);
            subtitleText.ShouldContain("00:00:02,100 --> 00:00:03,040");
            subtitleText.ShouldContain("第三镜结尾");
            // 全文件解码成功，不能只检查链接和容器头。
            await RunProcessAsync("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
            var pcm = Path.Combine(tempDir, "tail.pcm");
            await RunProcessAsync("ffmpeg", ["-v", "error", "-y", "-ss", "2.98", "-i", output, "-t", "0.04", "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", pcm]);
            var tail = await File.ReadAllBytesAsync(pcm);
            tail.Length.ShouldBeGreaterThan(3000);
            Enumerable.Range(0, tail.Length / 2).Select(index => Math.Abs((int)BitConverter.ToInt16(tail, index * 2)))
                .Average().ShouldBeGreaterThan(100);

            for (var index = 0; index < 3; index++)
            {
                var pixelPath = Path.Combine(tempDir, $"shot-{index}.rgb");
                await RunProcessAsync("ffmpeg", ["-v", "error", "-y", "-ss", $"{index}.5", "-i", output,
                    "-frames:v", "1", "-vf", "crop=2:2:640:360,format=rgb24", "-f", "rawvideo", pixelPath]);
                var pixel = await File.ReadAllBytesAsync(pixelPath);
                pixel[index].ShouldBeGreaterThan((byte)80);
                for (var channel = 0; channel < 3; channel++)
                    if (channel != index) pixel[index].ShouldBeGreaterThan(pixel[channel]);
            }

            var before = await ReadSubtitlePixelsAsync(output, "0.5");
            var middle = await ReadSubtitlePixelsAsync(output, "1.5");
            // 烧录文字应在原色画面上产生足量明亮像素，浏览器不用额外启用软字幕。
            var pixels = Path.Combine(tempDir, "subtitle.pgm");
            await RunProcessAsync("ffmpeg", ["-v", "error", "-y", "-ss", "0.5", "-i", output, "-frames:v", "1", "-vf", "crop=1280:180:0:540,format=gray", "-f", "rawvideo", pixels]);
            (await File.ReadAllBytesAsync(pixels)).Count(value => value > 210).ShouldBeGreaterThan(100);

            await File.WriteAllTextAsync(subtitles, original.Replace("第二镜旁白", "修改后的中段旁白"));
            var revised = Path.Combine(tempDir, "revised.mp4");
            await RunProcessAsync("ffmpeg", VideoExportCommandBuilder.Build(scenes, voices, subtitles, revised, "16:9", fonts));
            (await ReadSubtitlePixelsAsync(revised, "0.5")).ShouldBe(before);
            (await ReadSubtitlePixelsAsync(revised, "1.5")).ShouldNotBe(middle);
            await RunProcessAsync("ffmpeg", ["-v", "error", "-i", revised, "-f", "null", "-"]);
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
    }

    private static Task<string> ReadSubtitlePixelsAsync(string file, string position) => RunProcessAsync("ffmpeg", [
        "-v", "error", "-ss", position, "-i", file, "-frames:v", "1", "-vf", "crop=1280:180:0:540", "-f", "md5", "-",
    ]);

    private static async Task<string> RunProcessAsync(string fileName, IReadOnlyList<string> args, bool returnErrorOutput = false)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in args) startInfo.ArgumentList.Add(arg);
        using var process = Process.Start(startInfo)
                            ?? throw new InvalidOperationException($"无法启动 {fileName}");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            throw new TimeoutException($"{fileName} 超过一分钟未结束");
        }
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"{fileName} 执行失败 (exit={process.ExitCode}): {stderr}");
        return returnErrorOutput ? stderr : stdout;
    }
}
