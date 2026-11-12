using System.Diagnostics;
using System.Text;
using Microsoft.AspNetCore.Http;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class VideoClipImportTests
{
    [Fact]
    public async Task ImportedThreeClips_ShouldRemainDecodableAndKeepFractionalTimelineWithoutModelJobs()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"video-import-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var clips = new List<VideoAgentController.ImportedVideoClip>();
            foreach (var (duration, index) in new[] { (0.44, 0), (0.72, 1), (1.16, 2) })
            {
                var source = Path.Combine(directory, $"fixture-{index}.mp4");
                await MediaAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25",
                    "-t", duration.ToString(System.Globalization.CultureInfo.InvariantCulture), "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", source]);
                await using var stream = File.OpenRead(source);
                var file = new FormFile(stream, 0, stream.Length, "files", index == 0 ? "../../第一个镜头.mp4" : $"镜头{index + 1}.mp4");
                clips.Add(await VideoAgentController.PrepareImportedClipAsync(file, directory, index));
            }
            clips[0].Name.ShouldBe("第一个镜头");
            foreach (var clip in clips)
            {
                clip.Sha256.Length.ShouldBe(64);
                await MediaAsync("ffmpeg", ["-v", "error", "-i", clip.FilePath, "-f", "null", "-"]);
                var bytes = await File.ReadAllBytesAsync(clip.FilePath);
                Encoding.ASCII.GetString(bytes).IndexOf("moov", StringComparison.Ordinal)
                    .ShouldBeLessThan(Encoding.ASCII.GetString(bytes).IndexOf("mdat", StringComparison.Ordinal));
            }
            var assets = clips.Select((clip, index) => new StoredAsset(clip.Sha256, $"https://fixture.invalid/{index}.mp4", 1, "video/mp4")).ToList();
            var project = new VideoProject { Id = "project", Title = "固定三镜脚本" };
            var run = VideoAgentController.BuildImportedRun(project, "owner", "branch", clips, assets);
            run.Status.ShouldBe(VideoGenRunStatus.Editing);
            run.TaskPermitId.ShouldBeNull();
            run.DirectVideoJobId.ShouldBeNull();
            run.Scenes.Count.ShouldBe(3);
            run.Scenes.ShouldAllBe(scene => scene.Status == SceneItemStatus.Done && scene.JobId == null && scene.Versions.Count == 1);
            run.Scenes.Select(scene => scene.ActiveVersionId).ShouldBe(run.Scenes.Select(scene => scene.Versions.Single().Id));
            var timeline = VideoAgentController.BuildImportedTimeline(clips, run.Scenes);
            timeline[0].Clips[1].StartSeconds.ShouldBe(clips[0].DurationSeconds, 0.000001);
            timeline[0].Clips[2].StartSeconds.ShouldBe(clips[0].DurationSeconds + clips[1].DurationSeconds, 0.000001);
            timeline[0].Clips.Sum(clip => clip.DurationSeconds).ShouldBe(run.TotalDurationSeconds, 0.000001);
            timeline.Skip(1).ShouldAllBe(track => track.Clips.Count == 0);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task PlaylistDisguisedAsMp4_ShouldBeRejectedBeforeMediaProcess()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"video-import-invalid-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            await using var stream = new MemoryStream(Encoding.UTF8.GetBytes("#EXTM3U\nhttp://127.0.0.1/private\n"));
            var file = new FormFile(stream, 0, stream.Length, "files", "movie.mp4");
            var failure = await Should.ThrowAsync<InvalidDataException>(() => VideoAgentController.PrepareImportedClipAsync(file, directory, 0));
            failure.Message.ShouldContain("容器");
            File.Exists(Path.Combine(directory, "clip-00.mp4")).ShouldBeFalse();
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task AudioOnlyContainer_ShouldNotCreateAPlayableVideoScene()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"video-import-audio-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "audio.m4a");
            await MediaAsync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-c:a", "aac", path]);
            await using var stream = File.OpenRead(path);
            var file = new FormFile(stream, 0, stream.Length, "files", "audio.mp4");
            var failure = await Should.ThrowAsync<InvalidDataException>(() => VideoAgentController.PrepareImportedClipAsync(file, directory, 0));
            failure.Message.ShouldContain("画面");
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    private static async Task MediaAsync(string executable, IEnumerable<string> arguments)
    {
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        var error = process.StandardError.ReadToEndAsync();
        var output = process.StandardOutput.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); throw; }
        process.ExitCode.ShouldBe(0, await error);
        _ = await output;
    }
}
