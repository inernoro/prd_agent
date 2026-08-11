using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
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
            Mock<IAssetStorage> assetStorage)
        {
            Context = context;
            _client = client;
            _databaseName = databaseName;
            _services = services;
            _runStore = runStore;
            VideoClient = videoClient;
            _assetStorage = assetStorage;
            OwnerId = $"video-scene-concurrency-tests-{Guid.NewGuid():N}";
        }

        public MongoDbContext Context { get; }
        public Mock<IOpenRouterVideoClient> VideoClient { get; }
        public Mock<IAssetStorage> AssetStorage => _assetStorage;
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
            var services = new ServiceCollection()
                .AddSingleton(videoClient.Object)
                .AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>()
                .BuildServiceProvider();
            return new VideoSceneTestDatabase(
                context,
                client,
                databaseName,
                services,
                runStore,
                videoClient,
                assetStorage);
        }

        public VideoGenService CreateService() => new(
            Context,
            _runStore.Object,
            _assetStorage.Object,
            new LLMRequestContextAccessor(),
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
