using System.Diagnostics;
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public partial class VideoSceneConcurrencyTests
{
    [Fact]
    public async Task ImportClips_ShouldPersistNewEditableRunAndKeepPreviousRunWithoutAnySupplierCalls()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var project = await test.CreateService().CreateProjectAsync("video-agent", test.OwnerId,
            new CreateVideoProjectRequest { Title = "三镜已有素材" });
        var previous = NewRun("previous-import-project", test.OwnerId, SceneItemStatus.Done);
        previous.ProjectId = project.Id;
        await test.SaveRunAsync(previous);
        await test.Context.VideoProjects.UpdateOneAsync(item => item.Id == project.Id,
            Builders<VideoProject>.Update.Set(item => item.LatestRunId, previous.Id).Set(item => item.Status, VideoProjectStatus.Editing));
        test.AssetStorage.Setup(storage => storage.SaveAsync(It.IsAny<byte[]>(), "video/mp4", It.IsAny<CancellationToken>(),
                AppDomainPaths.DomainVideoAgent, AppDomainPaths.TypeVideo, null, ".mp4"))
            .ReturnsAsync((byte[] bytes, string mime, CancellationToken _, string? domain, string? type, string? fileName, string? extension) =>
            {
                var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                return new StoredAsset(sha, $"https://fixture.invalid/{sha}.mp4", bytes.Length, mime);
            });
        var controller = ImportController(test, test.OwnerId);
        var directory = Path.Combine(Path.GetTempPath(), $"import-controller-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var source = Path.Combine(directory, "scene.mp4");
            var info = new ProcessStartInfo("ffmpeg") { UseShellExecute = false, RedirectStandardError = true };
            foreach (var value in new[] { "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=160x90:r=25", "-t", "0.6", "-c:v", "libx264", "-threads", "1", source }) info.ArgumentList.Add(value);
            using (var process = Process.Start(info)!)
            {
                var error = process.StandardError.ReadToEndAsync();
                await process.WaitForExitAsync();
                process.ExitCode.ShouldBe(0, await error);
            }
            var bytes = await File.ReadAllBytesAsync(source);
            using var first = new MemoryStream(bytes);
            using var second = new MemoryStream(bytes);
            using var third = new MemoryStream(bytes);
            var result = await controller.ImportScenes(project.Id,
                [new FormFile(first, 0, bytes.Length, "files", "第一镜.mp4"), new FormFile(second, 0, bytes.Length, "files", "第二镜.mp4"), new FormFile(third, 0, bytes.Length, "files", "第三镜.mp4")]);
            result.ShouldBeOfType<OkObjectResult>();
            var saved = await test.Context.VideoProjects.Find(item => item.Id == project.Id).SingleAsync();
            saved.LatestRunId.ShouldNotBe(previous.Id);
            var imported = await test.Context.VideoGenRuns.Find(item => item.Id == saved.LatestRunId).SingleAsync();
            imported.Scenes.Count.ShouldBe(3);
            imported.Status.ShouldBe(VideoGenRunStatus.Editing);
            imported.DeploymentSlug.ShouldBe("import-test-branch");
            imported.TaskPermitId.ShouldBeNull();
            imported.Scenes.ShouldAllBe(scene => scene.VideoUrl != null && scene.JobId == null);
            saved.TimelineTracks.Single(track => track.Type == VideoTrackType.Video).Clips.Sum(clip => clip.DurationSeconds)
                .ShouldBe(imported.TotalDurationSeconds, 0.000001);
            (await test.Context.VideoGenRuns.Find(item => item.Id == previous.Id).SingleAsync()).Status.ShouldBe(previous.Status);
            test.VideoClient.Verify(client => client.SubmitAsync(It.IsAny<OpenRouterVideoSubmitRequest>(), It.IsAny<CancellationToken>()), Times.Never);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Theory]
    [InlineData("foreign-owner", 404)]
    [InlineData("foreign-app", 404)]
    [InlineData("active-scene-stale-project", 409)]
    [InlineData("active-export-stale-project", 409)]
    public async Task ImportClips_ShouldRejectForeignOrActuallyActiveProjectBeforeReadingMedia(string variant, int expectedStatus)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var project = new VideoProject { OwnerAdminId = test.OwnerId, Status = VideoProjectStatus.Editing,
            AppKey = variant == "foreign-app" ? "visual-agent" : "video-agent" };
        await test.Context.VideoProjects.InsertOneAsync(project);
        if (variant == "active-scene-stale-project")
        {
            var active = NewRun("import-active-scene", test.OwnerId, SceneItemStatus.Submitting);
            active.ProjectId = project.Id;
            active.Status = VideoGenRunStatus.Editing;
            await test.SaveRunAsync(active);
        }
        if (variant == "active-export-stale-project")
            await test.Context.VideoExportTasks.InsertOneAsync(new VideoExportTask { ProjectId = project.Id,
                OwnerAdminId = test.OwnerId, Status = VideoExportTaskStatus.Processing });
        using var stream = new MemoryStream(new byte[12]);
        var result = await ImportController(test, variant == "foreign-owner" ? "different-owner" : test.OwnerId)
            .ImportScenes(project.Id, [new FormFile(stream, 0, stream.Length, "files", "unread.mp4")]);
        ((ObjectResult)result).StatusCode.ShouldBe(expectedStatus);
        test.AssetStorage.Verify(storage => storage.SaveAsync(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>()), Times.Never);
    }

    private static VideoAgentController ImportController(VideoSceneTestDatabase test, string owner)
    {
        var controller = new VideoAgentController(test.CreateService(), test.Events, test.Context, Mock.Of<IModelPoolQueryService>(),
            test.VideoClient.Object, test.AssetStorage.Object, Mock.Of<IHttpClientFactory>(), new EphemeralDataProtectionProvider(),
            NullLogger<VideoAgentController>.Instance) { ExportDeploymentScope = "import-test-branch" };
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
            User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", owner)], "import-test")) } };
        return controller;
    }
}
