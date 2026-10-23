using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using System.Security.Cryptography;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class VideoSceneConcurrencyTests
{
    [Fact]
    public async Task CancelIdleEditingRun_ShouldReachTerminalAndDeleteOwnEmptyProject()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var service = test.CreateService();
        var project = await service.CreateProjectAsync("video-agent", test.OwnerId,
            new CreateVideoProjectRequest { Title = "取消后回收", SourceMarkdown = "最短分镜稿" });
        var run = NewRun("cancel-idle", test.OwnerId, SceneItemStatus.Draft, SceneItemStatus.Done);
        run.ProjectId = project.Id;
        await test.SaveRunAsync(run);

        (await service.CancelRunAsync(run.Id, test.OwnerId, run.AppKey)).ShouldBeTrue();
        var cancelled = await service.GetRunAsync(run.Id, test.OwnerId, run.AppKey);
        cancelled!.Status.ShouldBe(VideoGenRunStatus.Cancelled);
        cancelled.EndedAt.ShouldNotBeNull();
        (await service.TryQueueSceneRenderAsync(run.Id, test.OwnerId, 0, run.AppKey, false)).ShouldBeFalse();
        var deleted = await service.DeleteRunAsync(run.Id, test.OwnerId, true, run.AppKey);
        deleted!.ProjectDeleted.ShouldBeTrue();
        (await service.GetRunAsync(run.Id, test.OwnerId, run.AppKey)).ShouldBeNull();
        (await service.GetProjectAsync(project.Id, test.OwnerId, run.AppKey)).ShouldBeNull();
        test.VideoClient.Verify(x => x.SubmitAsync(It.IsAny<OpenRouterVideoSubmitRequest>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData(SceneItemStatus.Submitting)]
    [InlineData(SceneItemStatus.SubmittingClaimed)]
    [InlineData(SceneItemStatus.Polling)]
    [InlineData(SceneItemStatus.PollingClaimed)]
    [InlineData(SceneItemStatus.Rendering)]
    [InlineData(SceneItemStatus.Generating)]
    public async Task CancelActiveScene_ShouldNotPretendIdleOrPermitDeletion(string sceneStatus)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("cancel-active", test.OwnerId, sceneStatus);
        await test.SaveRunAsync(run);
        var service = test.CreateService();
        (await service.CancelRunAsync(run.Id, test.OwnerId, run.AppKey)).ShouldBeTrue();
        var current = await service.GetRunAsync(run.Id, test.OwnerId, run.AppKey);
        current!.Status.ShouldBe(VideoGenRunStatus.Editing);
        current.CancelRequested.ShouldBeTrue();
        current.Scenes[0].Status.ShouldBe(sceneStatus);
        await Should.ThrowAsync<InvalidOperationException>(() => service.DeleteRunAsync(run.Id, test.OwnerId, appKey: run.AppKey));
        (await service.TryQueueSceneRenderAsync(run.Id, test.OwnerId, 0, run.AppKey, false)).ShouldBeFalse();
    }

    [Fact]
    public async Task CancelWithActiveExport_ShouldNotClaimTerminalOrStartAnotherExport()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("cancel-export", test.OwnerId, SceneItemStatus.Done);
        run.Scenes[0].VideoUrl = "https://example.invalid/finished.mp4";
        await test.SaveRunAsync(run);
        await test.Context.VideoExportTasks.InsertOneAsync(new VideoExportTask
        {
            RunId = run.Id, AppKey = run.AppKey, OwnerAdminId = test.OwnerId,
            Status = VideoExportTaskStatus.Processing,
        });
        var service = test.CreateService();
        await service.CancelRunAsync(run.Id, test.OwnerId, run.AppKey);
        (await service.GetRunAsync(run.Id, test.OwnerId, run.AppKey))!.Status.ShouldBe(VideoGenRunStatus.Editing);
        await Should.ThrowAsync<InvalidOperationException>(() => service.RequestExportAsync(run.Id, test.OwnerId, run.AppKey));
        (await test.Context.VideoExportTasks.CountDocumentsAsync(x => x.RunId == run.Id)).ShouldBe(1);
    }

    [Fact]
    public async Task LateExportFailure_ShouldNotReopenCancelledRun()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("late-export", test.OwnerId, SceneItemStatus.Done);
        run.Status = VideoGenRunStatus.Cancelled;
        run.CancelRequested = true;
        run.CurrentPhase = "cancelled";
        await test.SaveRunAsync(run);
        var stale = NewRun("late-export", test.OwnerId, SceneItemStatus.Done);
        stale.Status = VideoGenRunStatus.Rendering;
        await test.CreateWorker().FailExportAsync(stale, "离线迟到失败");
        await test.CreateWorker().UpdateExportProgressAsync(run.Id, null, "export-uploading", 90);
        var current = await test.CreateService().GetRunAsync(run.Id, test.OwnerId, run.AppKey);
        current!.Status.ShouldBe(VideoGenRunStatus.Cancelled);
        current.CurrentPhase.ShouldBe("cancelled");
    }

    [Fact]
    public async Task StaleSceneWorker_AfterTerminalCancellation_ShouldNotPollOrDownload()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("late-scene", test.OwnerId, SceneItemStatus.PollingClaimed);
        run.Status = VideoGenRunStatus.Cancelled;
        run.CancelRequested = true;
        run.Scenes[0].JobId = "old-job";
        run.Scenes[0].RenderLeaseId = "old-lease";
        run.Scenes[0].SubmissionStartedAt = DateTime.UtcNow;
        await test.SaveRunAsync(run);
        var stale = NewRun("late-scene", test.OwnerId, SceneItemStatus.PollingClaimed);
        stale.Scenes = run.Scenes;
        await test.CreateWorker().ProcessSceneRenderAsync(stale, 0, "old-lease", resumeExistingJob: true);
        test.VideoClient.Verify(x => x.GetStatusAsync(It.IsAny<string>(), It.IsAny<string>(),
            It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
        test.VideoClient.Verify(x => x.DownloadVideoBytesAsync(It.IsAny<string>(), It.IsAny<string>(),
            It.IsAny<int>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
        var current = await test.CreateService().GetRunAsync(run.Id, test.OwnerId, run.AppKey);
        current!.Status.ShouldBe(VideoGenRunStatus.Cancelled);
        current.Scenes[0].Versions.ShouldBeEmpty();
    }

    [Fact]
    public async Task SceneCompletionRacingCancelAndDelete_ShouldReleaseAssetBeforeTakingRunLease()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var service = test.CreateService();
        var project = await service.CreateProjectAsync("video-agent", test.OwnerId,
            new CreateVideoProjectRequest { Title = "完成取消清理并发" });
        var run = NewRun("complete-cancel-delete", test.OwnerId, SceneItemStatus.PollingClaimed);
        run.ProjectId = project.Id;
        run.CancelRequested = true;
        run.Scenes[0].JobId = "completed-job";
        run.Scenes[0].RenderLeaseId = "completion-lease";
        run.Scenes[0].SubmissionStartedAt = DateTime.UtcNow;
        await test.SaveRunAsync(run);
        await test.Context.VideoProjects.UpdateOneAsync(x => x.Id == project.Id,
            Builders<VideoProject>.Update.Set(x => x.LatestRunId, run.Id));

        byte[] bytes = [1, 2, 3];
        var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var stored = new StoredAsset(sha, "https://example.invalid/completed.mp4", bytes.Length, "video/mp4");
        var savedAssets = new HashSet<string>();
        test.VideoClient.Setup(x => x.GetStatusAsync(It.IsAny<string>(), "completed-job",
                It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new OpenRouterVideoStatus { Status = "completed", VideoUrl = stored.Url });
        test.VideoClient.Setup(x => x.DownloadVideoBytesAsync(It.IsAny<string>(), "completed-job", 0,
                It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new OpenRouterVideoDownload { Success = true, Bytes = bytes, ContentType = "video/mp4" });
        test.AssetStorage.Setup(x => x.SaveAsync(It.IsAny<byte[]>(), "video/mp4", It.IsAny<CancellationToken>(),
                AppDomainPaths.DomainVideoAgent, AppDomainPaths.TypeVideo, null, null))
            .Returns(() => { savedAssets.Add(sha); return Task.FromResult(stored); });
        test.AssetStorage.Setup(x => x.DeleteByShaAsync(sha, It.IsAny<CancellationToken>(),
                AppDomainPaths.DomainVideoAgent, AppDomainPaths.TypeVideo))
            .Returns(() => { savedAssets.Remove(sha); return Task.CompletedTask; });

        var enteringSyncCancel = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resumeSyncCancel = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        test.WorkerVideoService.Setup(x => x.CancelRunAsync(run.Id, test.OwnerId, run.AppKey, It.IsAny<CancellationToken>()))
            .Returns(async () =>
            {
                enteringSyncCancel.TrySetResult();
                await resumeSyncCancel.Task;
                return await service.CancelRunAsync(run.Id, test.OwnerId, run.AppKey);
            });
        var completion = test.CreateWorker().ProcessSceneRenderAsync(run, 0, "completion-lease", resumeExistingJob: true);
        try
        {
            await enteringSyncCancel.Task.WaitAsync(TimeSpan.FromSeconds(5));
            // 在真实 worker 完成 CAS 后、Sync 请求 run 锁前冻结。旧实现此时仍持有 asset 锁，
            // 与 DeleteRun 的 run→asset 顺序相反；先验证租约已释放，避免让红例真挂死两分钟。
            var leases = test.Context.Database.GetCollection<BsonDocument>("video_asset_mutation_leases");
            (await leases.CountDocumentsAsync(new BsonDocument("_id", $"generated-video:{sha}"))).ShouldBe(0);
            (await service.GetRunAsync(run.Id, test.OwnerId, run.AppKey))!.Scenes[0].Status.ShouldBe(SceneItemStatus.Done);
            await service.CancelRunAsync(run.Id, test.OwnerId, run.AppKey);
            (await service.GetRunAsync(run.Id, test.OwnerId, run.AppKey))!.Status.ShouldBe(VideoGenRunStatus.Cancelled);
            var deleted = await service.DeleteRunAsync(run.Id, test.OwnerId, true, run.AppKey).WaitAsync(TimeSpan.FromSeconds(5));
            deleted!.Deleted.ShouldBeTrue();
            deleted.ArtifactsDeleted.ShouldBe(1);
            deleted.ProjectDeleted.ShouldBeTrue();
        }
        finally
        {
            resumeSyncCancel.TrySetResult();
            await completion.WaitAsync(TimeSpan.FromSeconds(5));
        }
        (await service.GetRunAsync(run.Id, test.OwnerId, run.AppKey)).ShouldBeNull();
        (await service.GetProjectAsync(project.Id, test.OwnerId, run.AppKey)).ShouldBeNull();
        savedAssets.ShouldBeEmpty();
        test.RunStore.Verify(x => x.AppendEventAsync(It.IsAny<string>(), run.Id, "scene.render.done",
            It.IsAny<object>(), It.IsAny<TimeSpan?>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task LateStoryboardResponse_AfterOwnerCancel_ShouldNotResurrectEditing(bool success)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("cancel-scripting", test.OwnerId);
        run.Status = VideoGenRunStatus.Scripting;
        run.ArticleMarkdown = "车站收到来信，次日走向晨光。";
        await test.SaveRunAsync(run);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var response = new TaskCompletionSource<GatewayRawResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        test.Gateway.Setup(x => x.ResolveModelAsync(It.IsAny<string>(), It.IsAny<string>(),
                It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayModelResolution { Success = true, ActualModel = "offline-only-chat" });
        test.Gateway.Setup(x => x.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(),
                It.IsAny<GatewayModelResolution>(), It.IsAny<CancellationToken>()))
            .Returns(() => { entered.TrySetResult(); return response.Task; });
        var pending = test.CreateWorker().ProcessStoryboardScriptingAsync(run);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await test.CreateService().CancelRunAsync(run.Id, test.OwnerId, run.AppKey);
        response.SetResult(success ? new GatewayRawResponse
        {
            Success = true,
            Content = "{\"choices\":[{\"message\":{\"content\":\"{\\\"scenes\\\":[{\\\"topic\\\":\\\"晨光\\\",\\\"prompt\\\":\\\"Morning platform\\\",\\\"duration\\\":5}]}\"}}]}",
        } : GatewayRawResponse.Fail("OFFLINE_FAILURE", "离线模拟失败"));
        await pending;
        var current = await test.CreateService().GetRunAsync(run.Id, test.OwnerId, run.AppKey);
        current!.Status.ShouldBe(VideoGenRunStatus.Cancelled);
        current.Scenes.ShouldBeEmpty();
        (await test.CreateService().DeleteRunAsync(run.Id, test.OwnerId, appKey: run.AppKey))!.Deleted.ShouldBeTrue();
        test.Gateway.Verify(x => x.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(),
            It.IsAny<GatewayModelResolution>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task WrongOwnerOrApp_CannotCancelOrDeleteOrphanProject()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var service = test.CreateService();
        var run = NewRun("foreign-cancel", test.OwnerId, SceneItemStatus.Draft);
        await test.SaveRunAsync(run);
        var project = await service.CreateProjectAsync(run.AppKey, test.OwnerId,
            new CreateVideoProjectRequest { Title = "归属边界", SourceMarkdown = "未创建任务的文稿" });
        (await service.CancelRunAsync(run.Id, "other-owner", run.AppKey)).ShouldBeFalse();
        (await service.CancelRunAsync(run.Id, test.OwnerId, "other-app")).ShouldBeFalse();
        (await service.DeleteEmptyProjectAsync(project.Id, "other-owner", run.AppKey)).ShouldBeFalse();
        (await service.DeleteEmptyProjectAsync(project.Id, test.OwnerId, "other-app")).ShouldBeFalse();
        (await service.GetRunAsync(run.Id, test.OwnerId, run.AppKey))!.CancelRequested.ShouldBeFalse();
        (await service.DeleteEmptyProjectAsync(project.Id, test.OwnerId, run.AppKey)).ShouldBeTrue();
        (await service.GetProjectAsync(project.Id, test.OwnerId, run.AppKey)).ShouldBeNull();
    }

    [Theory]
    [InlineData("run")]
    [InlineData("export")]
    [InlineData("asset")]
    [InlineData("timeline")]
    public async Task DeleteEmptyProject_ShouldRefuseAnyExistingDependency(string dependency)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var service = test.CreateService();
        var project = await service.CreateProjectAsync("video-agent", test.OwnerId, new CreateVideoProjectRequest { Title = "依赖保护" });
        if (dependency == "run")
        {
            var run = NewRun("referenced-project", test.OwnerId, SceneItemStatus.Draft);
            run.ProjectId = project.Id; await test.SaveRunAsync(run);
        }
        if (dependency == "export") await test.Context.VideoExportTasks.InsertOneAsync(new VideoExportTask
            { ProjectId = project.Id, OwnerAdminId = test.OwnerId, AppKey = project.AppKey });
        if (dependency == "asset") project.Assets.Add(new VideoProjectAsset { Url = "https://example.invalid/reference.jpg" });
        if (dependency == "timeline") project.TimelineTracks[0].Clips.Add(new VideoTimelineClip { AssetUrl = "https://example.invalid/clip.mp4" });
        await test.Context.VideoProjects.ReplaceOneAsync(x => x.Id == project.Id, project);
        await Should.ThrowAsync<InvalidOperationException>(() => service.DeleteEmptyProjectAsync(project.Id, test.OwnerId, project.AppKey));
        (await service.GetProjectAsync(project.Id, test.OwnerId, project.AppKey)).ShouldNotBeNull();
        test.AssetStorage.Verify(x => x.DeleteByShaAsync(It.IsAny<string>(), It.IsAny<CancellationToken>(),
            It.IsAny<string?>(), It.IsAny<string?>()), Times.Never);
    }

    [Fact]
    public async Task DeleteOrphanRacingCreateRun_ShouldNeverLeaveRunWithoutProject()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var service = test.CreateService();
        var project = await service.CreateProjectAsync("video-agent", test.OwnerId,
            new CreateVideoProjectRequest { Title = "创建回收竞争", SourceMarkdown = "最短文稿" });
        string? created = null;
        var create = Task.Run(async () =>
        {
            try { created = await service.CreateRunAsync(project.AppKey, test.OwnerId,
                new CreateVideoGenRunRequest { ProjectId = project.Id, Mode = VideoGenMode.Storyboard }); }
            catch (ArgumentException) { }
        });
        var delete = Task.Run(async () =>
        {
            try { await service.DeleteEmptyProjectAsync(project.Id, test.OwnerId, project.AppKey); }
            catch (InvalidOperationException) { }
        });
        await Task.WhenAll(create, delete);
        if (created != null) (await service.GetProjectAsync(project.Id, test.OwnerId, project.AppKey)).ShouldNotBeNull();
        else (await test.Context.VideoGenRuns.CountDocumentsAsync(x => x.ProjectId == project.Id)).ShouldBe(0);
    }

    [Fact]
    public async Task DeleteCompletedRun_ShouldRemoveOwnedArtifactRunExportAndEmptyProject()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var service = test.CreateService();
        var project = await service.CreateProjectAsync(
            "video-agent",
            test.OwnerId,
            new CreateVideoProjectRequest { Title = "稳定冒烟视频", SourceMarkdown = "测试" });
        var sha = new string('a', 64);
        var run = NewRun("delete-completed", test.OwnerId, SceneItemStatus.Done);
        run.ProjectId = project.Id;
        run.Status = VideoGenRunStatus.Completed;
        run.VideoAssetUrl = "https://assets.example/video-agent/video/test.mp4";
        run.VideoAssetSha256 = sha;
        await test.SaveRunAsync(run);
        await test.Context.VideoProjects.UpdateOneAsync(
            item => item.Id == project.Id,
            Builders<VideoProject>.Update.Set(item => item.LatestRunId, run.Id));
        await test.Context.VideoExportTasks.InsertOneAsync(new VideoExportTask
        {
            ProjectId = project.Id,
            RunId = run.Id,
            OwnerAdminId = test.OwnerId,
        });

        var result = await service.DeleteRunAsync(run.Id, test.OwnerId, deleteEmptyProject: true, appKey: run.AppKey);

        result.ShouldNotBeNull();
        result.Deleted.ShouldBeTrue();
        result.ProjectDeleted.ShouldBeTrue();
        result.ArtifactsDeleted.ShouldBe(1);
        (await test.Context.VideoGenRuns.CountDocumentsAsync(item => item.Id == run.Id)).ShouldBe(0);
        (await test.Context.VideoExportTasks.CountDocumentsAsync(item => item.RunId == run.Id)).ShouldBe(0);
        (await test.Context.VideoProjects.CountDocumentsAsync(item => item.Id == project.Id)).ShouldBe(0);
        test.AssetStorage.Verify(storage => storage.DeleteByShaAsync(
            sha,
            It.IsAny<CancellationToken>(),
            AppDomainPaths.DomainVideoAgent,
            AppDomainPaths.TypeVideo), Times.Once);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task DeleteCompletedRun_ShouldPreserveArtifactReferencedByProject(
        bool useTimelineReference)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var service = test.CreateService();
        var project = await service.CreateProjectAsync(
            "video-agent",
            test.OwnerId,
            new CreateVideoProjectRequest { Title = "引用保留测试", SourceMarkdown = "测试" });
        var sha = new string('b', 64);
        const string assetUrl = "https://assets.example/video-agent/video/shared.mp4";
        var run = NewRun("delete-referenced", test.OwnerId, SceneItemStatus.Done);
        run.ProjectId = project.Id;
        run.Status = VideoGenRunStatus.Completed;
        run.VideoAssetUrl = assetUrl;
        run.VideoAssetSha256 = sha;
        await test.SaveRunAsync(run);

        if (useTimelineReference)
        {
            project.TimelineTracks.First(track => track.Type == VideoTrackType.Video).Clips.Add(
                new VideoTimelineClip { AssetUrl = assetUrl });
        }
        else
        {
            project.Assets.Add(new VideoProjectAsset { Url = assetUrl, Name = "共享视频" });
        }
        project.LatestRunId = run.Id;
        await test.Context.VideoProjects.ReplaceOneAsync(item => item.Id == project.Id, project);

        var result = await service.DeleteRunAsync(
            run.Id,
            test.OwnerId,
            deleteEmptyProject: false,
            appKey: run.AppKey);

        result.ShouldNotBeNull();
        result.Deleted.ShouldBeTrue();
        result.ProjectDeleted.ShouldBeFalse();
        result.ArtifactsDeleted.ShouldBe(0);
        (await test.Context.VideoProjects.CountDocumentsAsync(item => item.Id == project.Id)).ShouldBe(1);
        test.AssetStorage.Verify(storage => storage.DeleteByShaAsync(
            It.IsAny<string>(),
            It.IsAny<CancellationToken>(),
            It.IsAny<string?>(),
            It.IsAny<string?>()), Times.Never);
    }

    [Fact]
    public async Task ConcurrentQueueRequests_ShouldOnlyTransitionOnce_AndNeverClearAnExistingClaim()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("concurrent-queue", test.OwnerId, SceneItemStatus.Done);
        await test.SaveRunAsync(run);
        var service = test.CreateService();

        var queued = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            service.TryQueueSceneRenderAsync(run.Id, run.OwnerAdminId, 0, run.AppKey, false)));

        queued.Count(result => result).ShouldBe(1);
        var worker = test.CreateWorker();
        var claims = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            worker.ClaimEditingSceneRenderAsync(CancellationToken.None)));
        var claimed = claims.Where(result => result != null).Select(result => result!).ToList();
        claimed.Count.ShouldBe(1,
            string.Join(", ", claimed.Select(result => $"{result.ClaimId}:{result.ResumeExistingJob}")));
        var claim = claimed[0];
        claim.ResumeExistingJob.ShouldBeFalse();

        var staleRetries = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            service.TryQueueSceneRenderAsync(run.Id, run.OwnerAdminId, 0, run.AppKey, false)));
        staleRetries.ShouldAllBe(result => result == false);

        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.SubmittingClaimed);
        persisted.Scenes[0].JobId.ShouldBe(claim.ClaimId);
    }

    [Fact]
    public async Task ConcurrentBatchRequests_ShouldQueueEachEligibleSceneExactlyOnce()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("concurrent-batch", test.OwnerId, SceneItemStatus.Draft, SceneItemStatus.Error);
        await test.SaveRunAsync(run);
        var service = test.CreateService();

        var counts = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ =>
            service.RenderScenesAsync(run.Id, run.OwnerAdminId, appKey: run.AppKey)));

        counts.Sum().ShouldBe(2);
        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes.ShouldAllBe(scene => scene.Status == SceneItemStatus.Submitting);
        persisted.Scenes.ShouldAllBe(scene => scene.SubmissionStartedAt.HasValue);
    }

    [Fact]
    public async Task ExpiredRenderLease_ShouldHaveOnePollingOwner_WithoutSubmittingAnotherJob()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("expired-lease", test.OwnerId, SceneItemStatus.PollingClaimed);
        run.Scenes[0].JobId = "upstream-job-1";
        run.Scenes[0].Model = "recorded-video-model";
        run.Scenes[0].RenderLeaseId = "lease:expired";
        run.Scenes[0].RenderLeaseExpiresAt = DateTime.UtcNow.AddMinutes(-1);
        await test.SaveRunAsync(run);

        var worker = test.CreateWorker();
        var recoveries = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            worker.RecoverExpiredSceneRenderLeaseAsync(CancellationToken.None)));
        recoveries.Count(result => result).ShouldBe(1);

        var claims = await Task.WhenAll(Enumerable.Range(0, 32).Select(_ =>
            worker.ClaimEditingSceneRenderAsync(CancellationToken.None)));
        var claimed = claims.Where(result => result != null).Select(result => result!).ToList();
        claimed.Count.ShouldBe(1,
            string.Join(", ", claimed.Select(result => $"{result.ClaimId}:{result.ResumeExistingJob}")));
        var claim = claimed[0];
        claim.ResumeExistingJob.ShouldBeTrue();
        claim.Run.Scenes[0].JobId.ShouldBe("upstream-job-1");

        var activeLeaseClaims = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ =>
            worker.ClaimEditingSceneRenderAsync(CancellationToken.None)));
        activeLeaseClaims.ShouldAllBe(result => result == null);

        var client = test.VideoClient;
        client.Setup(x => x.GetStatusAsync(
                It.IsAny<string>(),
                "upstream-job-1",
                It.IsAny<string?>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new OpenRouterVideoStatus { Status = "failed", ErrorMessage = "模拟上游失败" });

        await worker.ProcessSceneRenderAsync(claim.Run, 0, claim.ClaimId, resumeExistingJob: true);

        client.Verify(x => x.SubmitAsync(It.IsAny<OpenRouterVideoSubmitRequest>(), It.IsAny<CancellationToken>()), Times.Never);
        client.Verify(x => x.GetStatusAsync(
            It.IsAny<string>(), "upstream-job-1", "recorded-video-model", It.IsAny<CancellationToken>()), Times.Once);
        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.Error);
        persisted.Scenes[0].RenderLeaseId.ShouldBeNull();
    }

    [Fact]
    public async Task StalePreSubmitClaim_ShouldBecomeActionableError_InsteadOfAutoResubmitting()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("stale-claim", test.OwnerId, SceneItemStatus.SubmittingClaimed);
        run.Scenes[0].JobId = "claim:orphaned";
        run.Scenes[0].SubmissionStartedAt = DateTime.UtcNow.AddMinutes(-3);
        await test.SaveRunAsync(run);
        var worker = test.CreateWorker();

        var recovered = await Task.WhenAll(Enumerable.Range(0, 16).Select(_ =>
            worker.RecoverStaleSceneClaimAsync(CancellationToken.None)));

        recovered.Count(result => result).ShouldBe(1);
        test.VideoClient.Verify(x => x.SubmitAsync(It.IsAny<OpenRouterVideoSubmitRequest>(), It.IsAny<CancellationToken>()), Times.Never);
        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.Error);
        persisted.Scenes[0].JobId.ShouldBeNull();
        persisted.Scenes[0].ErrorMessage.ShouldNotBeNull();
        persisted.Scenes[0].ErrorMessage!.ShouldContain("避免重复扣费");
    }

    [Fact]
    public async Task LeaseLostDuringStatusCheck_ShouldStopBeforeDownloadingOrPersistingAVersion()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("lease-lost", test.OwnerId, SceneItemStatus.PollingClaimed);
        run.Scenes[0].JobId = "upstream-job-lease-lost";
        run.Scenes[0].RenderLeaseId = "lease:original";
        run.Scenes[0].RenderLeaseExpiresAt = DateTime.UtcNow.AddMinutes(2);
        run.Scenes[0].SubmissionStartedAt = DateTime.UtcNow;
        await test.SaveRunAsync(run);

        test.VideoClient.Setup(x => x.GetStatusAsync(
                It.IsAny<string>(),
                "upstream-job-lease-lost",
                It.IsAny<string?>(),
                It.IsAny<CancellationToken>()))
            .Returns(async () =>
            {
                await test.Context.VideoGenRuns.UpdateOneAsync(
                    x => x.Id == run.Id,
                    Builders<VideoGenRun>.Update
                        .Set("Scenes.0.RenderLeaseId", "lease:new-owner")
                        .Set("Scenes.0.RenderLeaseExpiresAt", DateTime.UtcNow.AddMinutes(2)));
                return new OpenRouterVideoStatus
                {
                    Status = "completed",
                    VideoUrl = "https://example.invalid/video.mp4",
                };
            });

        var worker = test.CreateWorker();
        await worker.ProcessSceneRenderAsync(run, 0, "lease:original", resumeExistingJob: true);

        test.VideoClient.Verify(x => x.SubmitAsync(
            It.IsAny<OpenRouterVideoSubmitRequest>(), It.IsAny<CancellationToken>()), Times.Never);
        test.VideoClient.Verify(x => x.DownloadVideoBytesAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<int>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Versions.ShouldBeEmpty();
        persisted.Scenes[0].RenderLeaseId.ShouldBe("lease:new-owner");
    }

    [Fact]
    public async Task WrongOwnerOrApp_ShouldNotQueueOrMutateTheScene()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("ownership", test.OwnerId, SceneItemStatus.Draft);
        await test.SaveRunAsync(run);
        var service = test.CreateService();

        (await service.TryQueueSceneRenderAsync(
            run.Id, "another-owner", 0, run.AppKey, false)).ShouldBeFalse();
        (await service.TryQueueSceneRenderAsync(
            run.Id, run.OwnerAdminId, 0, "another-app", false)).ShouldBeFalse();

        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.Draft);
        persisted.Scenes[0].JobId.ShouldBeNull();
    }

    [Fact]
    public async Task InvalidBatchIndex_ShouldFailBeforeQueuingAnyScene()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("invalid-index", test.OwnerId, SceneItemStatus.Draft, SceneItemStatus.Error);
        await test.SaveRunAsync(run);
        var service = test.CreateService();

        await Should.ThrowAsync<ArgumentOutOfRangeException>(() =>
            service.RenderScenesAsync(run.Id, run.OwnerAdminId, [-1, 0], appKey: run.AppKey));

        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.Draft);
        persisted.Scenes[1].Status.ShouldBe(SceneItemStatus.Error);
    }

    [Fact]
    public async Task CompletedRunRetry_ShouldAtomicallyReopenEditingAndQueueTheScene()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("completed-retry", test.OwnerId, SceneItemStatus.Error);
        run.Status = VideoGenRunStatus.Completed;
        run.CurrentPhase = "completed";
        run.VideoAssetUrl = "https://example.invalid/old-export.mp4";
        await test.SaveRunAsync(run);
        var service = test.CreateService();

        (await service.TryQueueSceneRenderAsync(
            run.Id, run.OwnerAdminId, 0, run.AppKey, reopenCompletedRun: true)).ShouldBeTrue();

        var persisted = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        persisted.Status.ShouldBe(VideoGenRunStatus.Editing);
        persisted.CurrentPhase.ShouldBe("editing");
        persisted.VideoAssetUrl.ShouldBeNull();
        persisted.Scenes[0].Status.ShouldBe(SceneItemStatus.Submitting);
    }

    private static VideoGenRun NewRun(string id, string ownerId, params string[] sceneStatuses) => new()
    {
        Id = $"video-scene-test-{id}",
        AppKey = "video-agent",
        OwnerAdminId = ownerId,
        Status = VideoGenRunStatus.Editing,
        Mode = VideoGenMode.Storyboard,
        CurrentPhase = "editing",
        Scenes = sceneStatuses.Select((status, index) => new VideoGenScene
        {
            Index = index,
            Topic = $"镜头 {index + 1}",
            Prompt = $"测试镜头 {index + 1}",
            Status = status,
        }).ToList(),
    };

    private sealed class VideoSceneTestDatabase : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;
        private readonly ServiceProvider _services;
        private readonly Mock<IRunEventStore> _runStore;
        private readonly Mock<IAssetStorage> _assetStorage;

        private VideoSceneTestDatabase(
            MongoDbContext context,
            MongoClient client,
            string databaseName,
            ServiceProvider services,
            Mock<IRunEventStore> runStore,
            Mock<IOpenRouterVideoClient> videoClient,
            Mock<IAssetStorage> assetStorage,
            Mock<ILlmGateway> gateway,
            Mock<IVideoGenService> workerVideoService)
        {
            Context = context;
            _client = client;
            _databaseName = databaseName;
            _services = services;
            _runStore = runStore;
            VideoClient = videoClient;
            _assetStorage = assetStorage;
            Gateway = gateway;
            WorkerVideoService = workerVideoService;
            OwnerId = $"video-scene-concurrency-tests-{Guid.NewGuid():N}";
        }

        public MongoDbContext Context { get; }
        public Mock<IOpenRouterVideoClient> VideoClient { get; }
        public Mock<IAssetStorage> AssetStorage => _assetStorage;
        public Mock<ILlmGateway> Gateway { get; }
        public Mock<IVideoGenService> WorkerVideoService { get; }
        public Mock<IRunEventStore> RunStore => _runStore;
        public string OwnerId { get; }

        public Task SaveRunAsync(VideoGenRun run) => Context.VideoGenRuns.InsertOneAsync(run);

        public static async Task<VideoSceneTestDatabase> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            var databaseName = $"video_scene_concurrency_{Guid.NewGuid():N}";
            var context = new MongoDbContext(connectionString, databaseName);
            var runStore = new Mock<IRunEventStore>();
            runStore.Setup(x => x.AppendEventAsync(
                    It.IsAny<string>(),
                    It.IsAny<string>(),
                    It.IsAny<string>(),
                    It.IsAny<object>(),
                    It.IsAny<TimeSpan?>(),
                    It.IsAny<CancellationToken>()))
                .ReturnsAsync(1);
            var videoClient = new Mock<IOpenRouterVideoClient>();
            var assetStorage = new Mock<IAssetStorage>();
            var gateway = new Mock<ILlmGateway>();
            var workerVideoService = new Mock<IVideoGenService>();
            var actualVideoService = new VideoGenService(context, runStore.Object, assetStorage.Object, NullLogger<VideoGenService>.Instance);
            workerVideoService.Setup(x => x.CancelRunAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
                .Returns((string id, string owner, string? app, CancellationToken ct) => actualVideoService.CancelRunAsync(id, owner, app, ct));
            var services = new ServiceCollection()
                .AddSingleton(videoClient.Object)
                .AddSingleton(gateway.Object)
                .AddSingleton(workerVideoService.Object)
                .AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>()
                .BuildServiceProvider();
            return new VideoSceneTestDatabase(
                context,
                client,
                databaseName,
                services,
                runStore,
                videoClient,
                assetStorage,
                gateway,
                workerVideoService);
        }

        public VideoGenService CreateService() => new(
            Context,
            _runStore.Object,
            _assetStorage.Object,
            NullLogger<VideoGenService>.Instance);

        public VideoGenRunWorker CreateWorker() => new(
            Context,
            _services.GetRequiredService<IServiceScopeFactory>(),
            _runStore.Object,
            _assetStorage.Object,
            NullLogger<VideoGenRunWorker>.Instance);

        public async ValueTask DisposeAsync()
        {
            await _services.DisposeAsync();
            await _client.DropDatabaseAsync(_databaseName);
        }
    }
}
