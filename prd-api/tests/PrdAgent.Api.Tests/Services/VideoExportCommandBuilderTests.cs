using System.Diagnostics;
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
            [new VideoExportAudioSource("music.mp3", 2, 3, Volume: 0.35)],
            "subtitles.srt",
            "export.mp4",
            "16:9");

        var filter = args[args.ToList().IndexOf("-filter_complex") + 1];
        filter.ShouldContain("[0:a]atrim=start=1:end=5.5");
        filter.ShouldContain("adelay=2000|2000");
        filter.ShouldContain("amix=inputs=2:duration=first");
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
    public async Task Build_ShouldProducePlayableMp4WithVideoAudioAndSubtitleStreams()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), $"video-export-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);
        try
        {
            var sceneWithoutAudio = Path.Combine(tempDir, "scene-no-audio.mp4");
            var sceneWithAudio = Path.Combine(tempDir, "scene-with-audio.mp4");
            var music = Path.Combine(tempDir, "music.m4a");
            var subtitles = Path.Combine(tempDir, "subtitles.srt");
            var output = Path.Combine(tempDir, "output.mp4");

            await RunProcessAsync("ffmpeg", [
                "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", sceneWithoutAudio,
            ]);
            await RunProcessAsync("ffmpeg", [
                "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=1",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", sceneWithAudio,
            ]);
            await RunProcessAsync("ffmpeg", [
                "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=2",
                "-c:a", "aac", music,
            ]);
            await File.WriteAllTextAsync(subtitles, "1\n00:00:00,100 --> 00:00:01,500\n合成字幕\n");

            var args = VideoExportCommandBuilder.Build(
                [
                    new VideoExportClipSource(sceneWithoutAudio, 1, false),
                    new VideoExportClipSource(sceneWithAudio, 1, true, Transition: "fade"),
                ],
                [new VideoExportAudioSource(music, 0.2, 1.2, Volume: 0.2)],
                subtitles,
                output,
                "16:9");
            await RunProcessAsync("ffmpeg", args);

            File.Exists(output).ShouldBeTrue();
            new FileInfo(output).Length.ShouldBeGreaterThan(0);
            var probe = await RunProcessAsync("ffprobe", [
                "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", output,
            ]);
            probe.ShouldContain("\"codec_type\": \"video\"");
            probe.ShouldContain("\"codec_type\": \"audio\"");
            probe.ShouldContain("\"codec_type\": \"subtitle\"");
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
    }

    private static async Task<string> RunProcessAsync(string fileName, IReadOnlyList<string> args)
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
        await process.WaitForExitAsync();
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"{fileName} 执行失败 (exit={process.ExitCode}): {stderr}");
        return stdout;
    }
}
