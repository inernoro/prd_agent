using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using System.Security.Claims;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public partial class VideoSceneConcurrencyTests
{
    [Fact]
    public async Task NarrationAdoption_PersistsWithRunAndInvalidatesOnlyCurrentExport()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("narration-adopt", test.OwnerId, SceneItemStatus.Done, SceneItemStatus.Done, SceneItemStatus.Done);
        run.Status = VideoGenRunStatus.Completed;
        run.VideoAssetUrl = "https://synthetic.invalid/previous-export.mp4";
        run.LatestExportTaskId = "previous-task";
        run.ExportedAt = DateTime.UtcNow;
        run.Scenes[1].VideoUrl = "https://synthetic.invalid/scene-2.mp4";
        await test.SaveRunAsync(run);
        var controller = CreateNarrationController(test);
        var narration = new VideoSceneNarration { SpeechRunId = "existing-speech", Text = "第二段旁白", DurationSeconds = 2.3 };

        Assert.True(await controller.SaveNarrationAsync(run, 1, narration));
        var fresh = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal(VideoGenRunStatus.Editing, fresh.Status);
        Assert.Null(fresh.VideoAssetUrl);
        Assert.Null(fresh.ExportedAt);
        Assert.Equal("existing-speech", fresh.Scenes[1].Narration!.SpeechRunId);
        Assert.Equal("第二段旁白", fresh.Scenes[1].Narration!.Text);
        Assert.Null(fresh.Scenes[0].Narration);
        Assert.Null(fresh.Scenes[2].Narration);
        Assert.Equal("previous-task", fresh.LatestExportTaskId);
        Assert.Empty(test.VideoClient.Invocations);
        Assert.Empty(test.AssetStorage.Invocations);
    }

    [Fact]
    public async Task NarrationAdoption_LegacyMissingNarrationAndVersionFieldsAllowsFirstAdoption()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("legacy-narration-adopt", test.OwnerId, SceneItemStatus.Done);
        run.Scenes[0].VideoUrl = "https://synthetic.invalid/existing.mp4";
        await test.SaveRunAsync(run);
        await test.Context.VideoGenRuns.UpdateOneAsync(x => x.Id == run.Id,
            Builders<VideoGenRun>.Update.Unset("Scenes.0.Narration").Unset("Scenes.0.ActiveVersionId"));

        Assert.True(await CreateNarrationController(test).SaveNarrationAsync(run, 0,
            new() { SpeechRunId = "first-adoption", Text = "首次采用", DurationSeconds = 1.5 }));
        var saved = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal("first-adoption", saved.Scenes[0].Narration!.SpeechRunId);
        Assert.Empty(test.VideoClient.Invocations);
    }

    [Theory]
    [InlineData("export-started")]
    [InlineData("cancelled")]
    [InlineData("deleted")]
    [InlineData("owner-changed")]
    [InlineData("app-changed")]
    [InlineData("deployment-changed")]
    [InlineData("video-changed")]
    [InlineData("active-version-changed")]
    [InlineData("other-adoption")]
    [InlineData("replaced-adoption")]
    public async Task NarrationAdoption_StaleWriterCannotReplaceChangedTask(string change)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var snapshot = NewRun("narration-fence", test.OwnerId, SceneItemStatus.Done);
        snapshot.DeploymentSlug = "synthetic-branch";
        snapshot.Scenes[0].VideoUrl = "https://synthetic.invalid/original.mp4";
        if (change == "replaced-adoption") snapshot.Scenes[0].Narration = new()
            { SpeechRunId = "original-adoption", Text = "原配音", DurationSeconds = 1.5 };
        await test.SaveRunAsync(snapshot);
        var current = await test.Context.VideoGenRuns.Find(x => x.Id == snapshot.Id).SingleAsync();
        if (change == "export-started") { current.Status = VideoGenRunStatus.Rendering; current.LatestExportTaskId = "new-export"; }
        if (change == "cancelled") { current.Status = VideoGenRunStatus.Cancelled; current.CancelRequested = true; }
        if (change == "deleted") current.DeletionRequestedAt = DateTime.UtcNow;
        if (change == "owner-changed") current.OwnerAdminId = "another-owner";
        if (change == "app-changed") current.AppKey = "visual-agent";
        if (change == "deployment-changed") current.DeploymentSlug = "another-branch";
        if (change == "video-changed") current.Scenes[0].VideoUrl = "https://synthetic.invalid/another-version.mp4";
        if (change == "active-version-changed") current.Scenes[0].ActiveVersionId = "same-url-different-version";
        if (change is "other-adoption" or "replaced-adoption") current.Scenes[0].Narration = new() { SpeechRunId = "already-adopted", Text = "保留", DurationSeconds = 2 };
        await test.Context.VideoGenRuns.ReplaceOneAsync(x => x.Id == current.Id, current);
        var before = current.ToBsonDocument();

        Assert.False(await CreateNarrationController(test).SaveNarrationAsync(snapshot, 0,
            new() { SpeechRunId = "late-speech", Text = "不可覆盖", DurationSeconds = 1.5 }));
        Assert.Equal(before, (await test.Context.VideoGenRuns.Find(x => x.Id == snapshot.Id).SingleAsync()).ToBsonDocument());
        Assert.Empty(test.VideoClient.Invocations);
        Assert.Empty(test.AssetStorage.Invocations);
    }

    private static VideoAgentController CreateNarrationController(VideoSceneTestDatabase test)
    {
        var controller = new VideoAgentController(test.CreateService(), test.Events, test.Context,
            Mock.Of<IModelPoolQueryService>(), test.VideoClient.Object, test.AssetStorage.Object,
            Mock.Of<IHttpClientFactory>(), new EphemeralDataProtectionProvider(), NullLogger<VideoAgentController>.Instance);
        controller.ControllerContext = new() { HttpContext = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, test.OwnerId)], "local-test")),
        } };
        return controller;
    }
}
