using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Api.Services;
using PrdAgent.Api.Controllers.Api;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using System.Security.Claims;
using System.Reflection;
using Moq;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public partial class VideoSceneConcurrencyTests
{
    [Theory]
    [InlineData("expired", true)]
    [InlineData("active", false)]
    [InlineData("foreign-scope", false)]
    [InlineData("legacy-no-lease", false)]
    public async Task ExportLeaseRecovery_OnlyExpiredOwnedHolderMayBeRecovered(string variant, bool shouldRecover)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("abandoned-export-run",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Rendering;
        run.ProjectId = "holder-project";run.LatestExportTaskId = "holder-task";
        run.DeploymentSlug = variant == "foreign-scope" ? "other-scope" : "synthetic-export-scope";
        // 无视频URL让本机恢复后沿真实处理器有限失败，不产生媒体下载或模型请求。
        await test.SaveRunAsync(run);
        var task = new VideoExportTask { Id = run.LatestExportTaskId,RunId = run.Id,ProjectId = run.ProjectId,
            OwnerAdminId = run.OwnerAdminId,AppKey = run.AppKey,Status = VideoExportTaskStatus.Processing,
            DeploymentSlug = run.DeploymentSlug,StartedAt = DateTime.UtcNow.AddHours(-1) };
        var receipt = task.ToBsonDocument();
        receipt["WorkerLeaseId"] = variant == "legacy-no-lease" ? BsonNull.Value : "synthetic-original-holder";
        receipt["WorkerLeaseExpiresAt"] = new BsonDateTime(variant == "active" ? DateTime.UtcNow.AddMinutes(2) : DateTime.UtcNow.AddMinutes(-2));
        await test.Context.Database.GetCollection<BsonDocument>("video_export_tasks").InsertOneAsync(receipt);
        using var worker = test.CreateWorker();worker.QueueDeploymentScope = "synthetic-export-scope";
        await worker.StartAsync(default);
        try
        {
            var until = DateTime.UtcNow.AddSeconds(shouldRecover ? 3 : 0.25);
            while (DateTime.UtcNow < until)
            {
                var current = await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync();
                if (shouldRecover && current.Status == VideoExportTaskStatus.Failed) break;
                await Task.Delay(30);
            }
        }
        finally { await worker.StopAsync(default); }
        var saved = await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync();
        Assert.Equal(shouldRecover ? VideoExportTaskStatus.Failed : VideoExportTaskStatus.Processing,saved.Status);
        Assert.Equal(task.OwnerAdminId,saved.OwnerAdminId);Assert.Equal(task.DeploymentSlug,saved.DeploymentSlug);
        Assert.Empty(test.AssetStorage.Invocations);Assert.Empty(test.VideoClient.Invocations);
    }
    [Fact]
    public async Task ExportHolder_OldRevisionMustNeverAutomaticallyClaimNewRevisionTask()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        const string branch = "synthetic-project::synthetic-branch";
        var run = NewRun("new-revision-export",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Rendering;
        run.DeploymentSlug = branch + "::revision::new";run.ProjectId = "reverse-project";run.LatestExportTaskId = "new-task";
        run.Scenes[0].VideoUrl = "https://synthetic.invalid/recorded-scene.mp4";
        await test.SaveRunAsync(run);
        var task = new VideoExportTask { Id = run.LatestExportTaskId,RunId = run.Id,OwnerAdminId = test.OwnerId,
            AppKey = run.AppKey,ProjectId = run.ProjectId,DeploymentSlug = run.DeploymentSlug };
        await test.Context.VideoExportTasks.InsertOneAsync(task);
        using var old = test.CreateWorker();old.QueueDeploymentScope = branch + "::revision::old";old.ExportDurableDeploymentScope = branch;
        Assert.Null(await old.ClaimExportTaskAsync(default));
        Assert.Equal(run.DeploymentSlug,(await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).DeploymentSlug);
        Assert.Equal(VideoExportTaskStatus.ScopedQueued,(await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync()).Status);
        Assert.Empty(test.AssetStorage.Invocations);Assert.Empty(test.VideoClient.Invocations);
    }

    [Theory]
    [InlineData("queued",true)]
    [InlineData("legacy-queued",true)]
    [InlineData("legacy-unscoped-queued",true)]
    [InlineData("expired",true)]
    [InlineData("active",false)]
    [InlineData("legacy-no-lease",false)]
    [InlineData("foreign-owner",false)]
    [InlineData("foreign-branch",false)]
    public async Task ExportHolder_AuthenticatedOwnerReadIsTheOnlyRevisionSelection(string variant,bool move)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        const string branch = "synthetic-project::synthetic-branch";
        var run = NewRun("owned-read-export",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Rendering;
        run.ProjectId = "read-project";run.LatestExportTaskId = "read-task";
        run.DeploymentSlug = variant == "foreign-branch" ? "synthetic-project::foreign::revision::old" : branch + "::revision::old";
        run.Scenes[0].VideoUrl = "https://synthetic.invalid/existing-scene.mp4";
        await test.SaveRunAsync(run);
        var task = new VideoExportTask { Id = run.LatestExportTaskId,RunId = run.Id,OwnerAdminId = test.OwnerId,
            AppKey = run.AppKey,ProjectId = run.ProjectId,DeploymentSlug = variant == "legacy-unscoped-queued" ? null : run.DeploymentSlug,
            Status = variant is "queued" or "legacy-queued" or "legacy-unscoped-queued" ? (variant == "queued" ? VideoExportTaskStatus.ScopedQueued : VideoExportTaskStatus.Queued) : VideoExportTaskStatus.Processing,
            WorkerLeaseId = variant == "legacy-no-lease" ? null : "synthetic-original-holder",
            WorkerLeaseExpiresAt = variant == "active" ? DateTime.UtcNow.AddMinutes(2) : DateTime.UtcNow.AddMinutes(-2) };
        await test.Context.VideoExportTasks.InsertOneAsync(task);
        var principal = new ClaimsPrincipal(new ClaimsIdentity(new[] {
            new Claim(ClaimTypes.NameIdentifier,variant == "foreign-owner" ? "different-owner" : test.OwnerId),
            new Claim("sub",variant == "foreign-owner" ? "different-owner" : test.OwnerId) },"local-test-auth"));
        var controller = new VideoAgentController(videoGenService: test.CreateService(),runStore: test.Events,
            db: test.Context,modelPoolQuery: Mock.Of<IModelPoolQueryService>(),videoClient: test.VideoClient.Object,
            assetStorage: test.AssetStorage.Object,httpClientFactory: Mock.Of<IHttpClientFactory>(),
            dataProtectionProvider: new EphemeralDataProtectionProvider(),logger: NullLogger<VideoAgentController>.Instance);
        controller.ExportDeploymentScope = branch + "::revision::new";controller.ExportDurableScope = branch;
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = principal } };
        var result = await controller.GetRun(run.Id,default);
        Assert.Equal(variant == "foreign-owner" ? 404 : 200,(result as ObjectResult)!.StatusCode);
        var saved = await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync();
        Assert.Equal(move ? branch + "::revision::new" : task.DeploymentSlug,saved.DeploymentSlug);
        Assert.Equal(move ? VideoExportTaskStatus.ScopedQueued : task.Status,saved.Status);
        if (move)
        {
            using var old = test.CreateWorker();old.QueueDeploymentScope = branch + "::revision::old";old.ExportDurableDeploymentScope = branch;
            Assert.Null(await old.ClaimExportTaskAsync(default));
            using var current = test.CreateWorker();current.QueueDeploymentScope = branch + "::revision::new";current.ExportDurableDeploymentScope = branch;
            Assert.Equal(task.Id,(await current.ClaimExportTaskAsync(default))!.Id);
        }
        Assert.Empty(test.VideoClient.Invocations);Assert.Empty(test.AssetStorage.Invocations);
    }

    [Fact]
    public async Task ExportHolder_ReclaimedIdentityRejectsEveryLateWriteAndDoesNotMintTaskOrPermit()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("reclaim-proof",test.OwnerId,SceneItemStatus.Done);run.Mode = VideoGenMode.Storyboard;
        run.Status = VideoGenRunStatus.Rendering;run.DeploymentSlug = "synthetic-export-scope";
        run.ProjectId = "reclaim-project";run.LatestExportTaskId = "reclaim-task";
        run.Scenes[0].VideoUrl = "https://synthetic.invalid/recorded-scene.mp4";
        await test.SaveRunAsync(run);
        await test.Context.VideoExportTasks.InsertOneAsync(new VideoExportTask { Id = run.LatestExportTaskId,
            RunId = run.Id,ProjectId = run.ProjectId,AppKey = run.AppKey,OwnerAdminId = test.OwnerId,DeploymentSlug = run.DeploymentSlug });
        using var worker = test.CreateWorker();worker.QueueDeploymentScope = run.DeploymentSlug;
        var old = (await worker.ClaimExportTaskAsync(default))!;Assert.NotNull(old.WorkerLeaseId);
        await test.Context.VideoExportTasks.UpdateOneAsync(x => x.Id == old.Id,
            Builders<VideoExportTask>.Update.Set(x => x.WorkerLeaseExpiresAt,DateTime.UtcNow.AddMinutes(-2)));
        Assert.False(await worker.RenewExportHolderAsync(run,old));
        Assert.True(await worker.RecoverExpiredExportHolderAsync(default));
        var current = (await worker.ClaimExportTaskAsync(default))!;Assert.NotEqual(old.WorkerLeaseId,current.WorkerLeaseId);
        Assert.True(await worker.RenewExportHolderAsync(run,current));
        Assert.False(await worker.RecordCompletedExportAsync(run,old,new PrdAgent.Infrastructure.Services.AssetStorage.StoredAsset(
            new string('a',64),"https://synthetic.invalid/late-output.mp4",3,"video/mp4"),null));
        await (Task)typeof(VideoGenRunWorker).GetMethod("FailExportAsync",BindingFlags.Instance|BindingFlags.NonPublic)!
            .Invoke(worker,new object?[] {run,"synthetic-late-failure",old.Id,old})!;
        await Assert.ThrowsAsync<OperationCanceledException>(() => (Task)typeof(VideoGenRunWorker)
            .GetMethod("UpdateExportProgressAsync",BindingFlags.Instance|BindingFlags.NonPublic)!
            .Invoke(worker,new object[] {run,old,"late-progress",80})!);
        var after = await test.Context.VideoExportTasks.Find(x => x.Id == current.Id).SingleAsync();
        Assert.Equal(VideoExportTaskStatus.Processing,after.Status);Assert.Equal(current.WorkerLeaseId,after.WorkerLeaseId);
        Assert.Null(after.OutputUrl);Assert.Equal(1,await test.Context.VideoExportTasks.CountDocumentsAsync(FilterDefinition<VideoExportTask>.Empty));
        Assert.Equal(0,await test.Data.Database.GetCollection<PrdAgent.Core.LlmGateway.GatewayTaskPermitRecord>(
            PrdAgent.Core.LlmGateway.GatewayTaskPermitRecord.CollectionName).CountDocumentsAsync(FilterDefinition<PrdAgent.Core.LlmGateway.GatewayTaskPermitRecord>.Empty));
        Assert.Empty(test.VideoClient.Invocations);Assert.Empty(test.AssetStorage.Invocations);
    }

    [Fact]
    public async Task ExportHolder_CreateGapLinksOnlyOriginalTaskBeforeClaimAndNormalRepeatReturnsIt()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("export-create-gap",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Editing;run.ProjectId = "gap-project";
        run.DeploymentSlug = "synthetic-export-scope";run.LatestExportTaskId = null;
        run.Scenes[0].VideoUrl = "https://synthetic.invalid/already-generated.mp4";await test.SaveRunAsync(run);
        var task = new VideoExportTask { Id = "gap-task",RunId = run.Id,OwnerAdminId = test.OwnerId,
            AppKey = run.AppKey,ProjectId = run.ProjectId,DeploymentSlug = run.DeploymentSlug };
        await test.Context.VideoExportTasks.InsertOneAsync(task);
        using var worker = test.CreateWorker();worker.QueueDeploymentScope = run.DeploymentSlug;
        Assert.Equal(task.Id,(await worker.ClaimExportTaskAsync(default))!.Id);
        var linked = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal(task.Id,linked.LatestExportTaskId);Assert.Equal(VideoGenRunStatus.Rendering,linked.Status);
        var service = test.CreateService();service.ExportDeploymentScope = run.DeploymentSlug;
        Assert.Equal(task.Id,(await service.RequestExportAsync(run.Id,test.OwnerId,run.AppKey)).Id);
        Assert.Equal(1,await test.Context.VideoExportTasks.CountDocumentsAsync(FilterDefinition<VideoExportTask>.Empty));
        Assert.Empty(test.VideoClient.Invocations);Assert.Empty(test.AssetStorage.Invocations);
    }

    [Fact]
    public async Task ExportHolder_OwnerCancellationTerminatesOnlyOwnedActiveExportsAndRetainsCompletedOutput()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("cancel-export-holders",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Rendering;await test.SaveRunAsync(run);
        var tasks = new[] {
            new VideoExportTask { Id = "active-own",RunId = run.Id,OwnerAdminId = test.OwnerId,AppKey = run.AppKey,Status = VideoExportTaskStatus.Processing,WorkerLeaseId = "active-holder",WorkerLeaseExpiresAt = DateTime.UtcNow.AddMinutes(2) },
            new VideoExportTask { Id = "queued-own",RunId = run.Id,OwnerAdminId = test.OwnerId,AppKey = run.AppKey },
            new VideoExportTask { Id = "complete-own",RunId = run.Id,OwnerAdminId = test.OwnerId,AppKey = run.AppKey,Status = VideoExportTaskStatus.Completed,OutputUrl = "https://synthetic.invalid/old-output.mp4" },
            new VideoExportTask { Id = "foreign",RunId = run.Id,OwnerAdminId = "different-owner",AppKey = run.AppKey,Status = VideoExportTaskStatus.Processing } };
        await test.Context.VideoExportTasks.InsertManyAsync(tasks);
        Assert.True(await test.CreateService().CancelRunAsync(run.Id,test.OwnerId,run.AppKey));
        Assert.True(await test.CreateService().CancelRunAsync(run.Id,test.OwnerId,run.AppKey));
        var saved = (await test.Context.VideoExportTasks.Find(FilterDefinition<VideoExportTask>.Empty).ToListAsync()).ToDictionary(x => x.Id);
        Assert.Equal(VideoExportTaskStatus.Cancelled,saved["active-own"].Status);Assert.Null(saved["active-own"].WorkerLeaseExpiresAt);
        Assert.Equal(VideoExportTaskStatus.Cancelled,saved["queued-own"].Status);Assert.Equal(VideoExportTaskStatus.Processing,saved["foreign"].Status);
        Assert.Equal(VideoExportTaskStatus.Completed,saved["complete-own"].Status);Assert.Equal(tasks[2].OutputUrl,saved["complete-own"].OutputUrl);
        Assert.Empty(test.VideoClient.Invocations);Assert.Empty(test.AssetStorage.Invocations);
    }

    [Theory]
    [InlineData(VideoExportTaskStatus.Failed)]
    [InlineData(VideoExportTaskStatus.Cancelled)]
    [InlineData(VideoExportTaskStatus.Completed)]
    public async Task ExportHolder_NormalReexportReplacesOnlyTerminalPreviousReference(string previousStatus)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("terminal-reexport",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;
        run.Status = previousStatus == VideoExportTaskStatus.Completed ? VideoGenRunStatus.Completed : VideoGenRunStatus.Editing;
        run.ProjectId = "terminal-project";run.LatestExportTaskId = "previous-terminal";
        run.DeploymentSlug = "synthetic-export-scope";
        run.Scenes[0].VideoUrl = "https://synthetic.invalid/already-generated.mp4";
        await test.SaveRunAsync(run);
        await test.Context.VideoProjects.InsertOneAsync(new VideoProject { Id = run.ProjectId,
            OwnerAdminId = test.OwnerId,AppKey = run.AppKey,LatestRunId = run.Id,
            LatestExportTaskId = run.LatestExportTaskId,
            Status = previousStatus == VideoExportTaskStatus.Completed ? VideoProjectStatus.Completed : VideoProjectStatus.Editing });
        await test.Context.VideoExportTasks.InsertOneAsync(new VideoExportTask { Id = run.LatestExportTaskId,
            RunId = run.Id,OwnerAdminId = test.OwnerId,AppKey = run.AppKey,ProjectId = run.ProjectId,
            DeploymentSlug = run.DeploymentSlug,Status = previousStatus });
        var service = test.CreateService();service.ExportDeploymentScope = run.DeploymentSlug;
        if (previousStatus == VideoExportTaskStatus.Completed)
        {
            await service.UpdateSceneAsync(run.Id,test.OwnerId,0,new UpdateVideoSceneRequest { Topic = "本机修改已生成分镜" },run.AppKey);
            Assert.Equal(VideoGenRunStatus.Editing,(await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).Status);
            Assert.Equal(VideoProjectStatus.Completed,(await test.Context.VideoProjects.Find(x => x.Id == run.ProjectId).SingleAsync()).Status);
        }
        var next = await service.RequestExportAsync(run.Id,test.OwnerId,run.AppKey);
        Assert.NotEqual(run.LatestExportTaskId,next.Id);
        Assert.Equal(next.Id,(await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).LatestExportTaskId);
        Assert.Equal(next.Id,(await test.Context.VideoProjects.Find(x => x.Id == run.ProjectId).SingleAsync()).LatestExportTaskId);
        Assert.Equal(next.Id,(await service.RequestExportAsync(run.Id,test.OwnerId,run.AppKey)).Id);
        Assert.Equal(previousStatus,(await test.Context.VideoExportTasks.Find(x => x.Id == run.LatestExportTaskId).SingleAsync()).Status);
        Assert.Equal(2,await test.Context.VideoExportTasks.CountDocumentsAsync(FilterDefinition<VideoExportTask>.Empty));
        Assert.Empty(test.AssetStorage.Invocations);Assert.Empty(test.VideoClient.Invocations);
    }

    [Fact]
    public async Task ExportHolder_CompletedHandoffGapDoesNotConsumeReceiptBeforeParentMoves()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        const string branch = "synthetic-project::synthetic-branch";
        var run = NewRun("receipt-handoff-gap",test.OwnerId,SceneItemStatus.Done);
        run.Status = VideoGenRunStatus.Rendering;run.ProjectId = "receipt-gap-project";
        run.LatestExportTaskId = "receipt-gap-task";run.DeploymentSlug = branch + "::revision::old";
        await test.SaveRunAsync(run);
        await test.Context.VideoProjects.InsertOneAsync(new VideoProject { Id = run.ProjectId,
            OwnerAdminId = test.OwnerId,AppKey = run.AppKey,LatestRunId = run.Id,
            LatestExportTaskId = run.LatestExportTaskId,Status = VideoProjectStatus.Rendering });
        var task = new VideoExportTask { Id = run.LatestExportTaskId,RunId = run.Id,ProjectId = run.ProjectId,
            OwnerAdminId = test.OwnerId,AppKey = run.AppKey,Status = VideoExportTaskStatus.Completed,
            DeploymentSlug = branch + "::revision::new",OutputUrl = "https://synthetic.invalid/existing-result.mp4",
            OutputSha256 = new string('a',64),EndedAt = DateTime.UtcNow };
        await test.Context.VideoExportTasks.InsertOneAsync(task);
        using var worker = test.CreateWorker();worker.QueueDeploymentScope = task.DeploymentSlug;worker.ExportDurableDeploymentScope = branch;
        Assert.False(await worker.RecoverCompletedExportTaskAsync(default));
        Assert.Null((await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync()).RunReconciledAt);
        await PrdAgent.Infrastructure.Services.VideoGenService.RefreshOwnedExportScopeAsync(test.Context,run,
            test.OwnerId,run.AppKey,task.DeploymentSlug,branch,default);
        Assert.True(await worker.RecoverCompletedExportTaskAsync(default));
        Assert.Equal(VideoGenRunStatus.Completed,(await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).Status);
        Assert.Equal(VideoProjectStatus.Completed,(await test.Context.VideoProjects.Find(x => x.Id == run.ProjectId).SingleAsync()).Status);
        Assert.NotNull((await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync()).RunReconciledAt);
        Assert.Empty(test.AssetStorage.Invocations);Assert.Empty(test.VideoClient.Invocations);
    }

    [Theory]
    [InlineData("cancelled")]
    [InlineData("deleted")]
    [InlineData("superseded")]
    public async Task ExportHolder_InvalidatedScopeHandoffRetiresReceiptWithoutBlockingNext(string variant)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("invalid-handoff",test.OwnerId,SceneItemStatus.Done);
        run.Status = VideoGenRunStatus.Rendering;run.ProjectId = "invalid-project";
        run.LatestExportTaskId = "first-receipt";run.DeploymentSlug = "synthetic-branch::revision::old";
        if (variant == "deleted") run.DeletionRequestedAt = DateTime.UtcNow;
        if (variant == "superseded") run.LatestExportTaskId = "newer-export";
        await test.SaveRunAsync(run);
        var first = new VideoExportTask { Id = "first-receipt",RunId = run.Id,ProjectId = run.ProjectId,
            OwnerAdminId = test.OwnerId,AppKey = run.AppKey,Status = VideoExportTaskStatus.Completed,
            DeploymentSlug = "synthetic-branch::revision::new",OutputUrl = "https://synthetic.invalid/retained.mp4",
            OutputSha256 = new string('a',64),EndedAt = DateTime.UtcNow.AddMinutes(-2) };
        await test.Context.VideoExportTasks.InsertOneAsync(first);
        if (variant == "cancelled") Assert.True(await test.CreateService().CancelRunAsync(run.Id,test.OwnerId,run.AppKey));
        var before = (await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).ToBsonDocument();
        var nextRun = NewRun("next-receipt-run",test.OwnerId,SceneItemStatus.Done);
        nextRun.Status = VideoGenRunStatus.Rendering;nextRun.DeploymentSlug = first.DeploymentSlug;
        nextRun.LatestExportTaskId = "next-receipt";await test.SaveRunAsync(nextRun);
        await test.Context.VideoExportTasks.InsertOneAsync(new VideoExportTask { Id = nextRun.LatestExportTaskId,
            RunId = nextRun.Id,OwnerAdminId = test.OwnerId,AppKey = nextRun.AppKey,ProjectId = string.Empty,
            DeploymentSlug = first.DeploymentSlug,Status = VideoExportTaskStatus.Completed,
            OutputUrl = "https://synthetic.invalid/next.mp4",OutputSha256 = new string('b',64),EndedAt = DateTime.UtcNow });
        using var worker = test.CreateWorker();worker.QueueDeploymentScope = first.DeploymentSlug;
        Assert.True(await worker.RecoverCompletedExportTaskAsync(default));
        Assert.NotNull((await test.Context.VideoExportTasks.Find(x => x.Id == first.Id).SingleAsync()).RunReconciledAt);
        Assert.Equal(before,(await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).ToBsonDocument());
        Assert.True(await worker.RecoverCompletedExportTaskAsync(default));
        Assert.Equal(VideoGenRunStatus.Completed,(await test.Context.VideoGenRuns.Find(x => x.Id == nextRun.Id).SingleAsync()).Status);
        Assert.Empty(test.AssetStorage.Invocations);Assert.Empty(test.VideoClient.Invocations);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExportHolder_RequestAcceptsConcurrentLinkOnlyToSameTask(bool differentTarget)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("concurrent-export-link",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Editing;
        run.DeploymentSlug = "synthetic-export-scope";run.Scenes[0].VideoUrl = "https://synthetic.invalid/existing.mp4";
        await test.SaveRunAsync(run);
        var actualRuns = test.Context.VideoGenRuns;var actualTasks = test.Context.VideoExportTasks;
        var runs = new Mock<IMongoCollection<VideoGenRun>>(MockBehavior.Strict);
        runs.SetupGet(x => x.DocumentSerializer).Returns(actualRuns.DocumentSerializer);
        runs.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<VideoGenRun>>(),It.IsAny<FindOptions<VideoGenRun,VideoGenRun>>(),It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoGenRun> f,FindOptions<VideoGenRun,VideoGenRun> o,CancellationToken c) => actualRuns.FindAsync(f,o,c));
        var updates = 0;
        runs.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<VideoGenRun>>(),It.IsAny<UpdateDefinition<VideoGenRun>>(),It.IsAny<UpdateOptions>(),It.IsAny<CancellationToken>()))
            .Returns(async (FilterDefinition<VideoGenRun> f,UpdateDefinition<VideoGenRun> u,UpdateOptions o,CancellationToken c) => {
                if (++updates == 1)
                {
                    Assert.Equal(1,(await actualRuns.UpdateOneAsync(f,u,o,c)).MatchedCount);
                    if (differentTarget) await actualRuns.UpdateOneAsync(x => x.Id == run.Id,
                        Builders<VideoGenRun>.Update.Set(x => x.LatestExportTaskId,"different-current-export"));
                }
                return await actualRuns.UpdateOneAsync(f,u,o,c);
            });
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<VideoGenRun>("video_gen_runs",null)).Returns(runs.Object);
        database.Setup(x => x.GetCollection<VideoExportTask>("video_export_tasks",null)).Returns(actualTasks);
        typeof(MongoDbContext).GetField("_database",BindingFlags.NonPublic|BindingFlags.Instance)!.SetValue(test.Context,database.Object);
        var service = test.CreateService();service.ExportDeploymentScope = run.DeploymentSlug;
        if (differentTarget)
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.RequestExportAsync(run.Id,test.OwnerId,run.AppKey));
            Assert.Equal("different-current-export",(await actualRuns.Find(x => x.Id == run.Id).SingleAsync()).LatestExportTaskId);
        }
        else
        {
            var linked = await service.RequestExportAsync(run.Id,test.OwnerId,run.AppKey);
            Assert.Equal(linked.Id,(await actualRuns.Find(x => x.Id == run.Id).SingleAsync()).LatestExportTaskId);
            Assert.Equal(VideoExportTaskStatus.ScopedQueued,(await actualTasks.Find(x => x.Id == linked.Id).SingleAsync()).Status);
        }
        Assert.Equal(1,await actualTasks.CountDocumentsAsync(FilterDefinition<VideoExportTask>.Empty));
        Assert.Empty(test.AssetStorage.Invocations);Assert.Empty(test.VideoClient.Invocations);
    }

    [Fact]
    public async Task ExportHolder_InterruptedReexportRepairsOriginalProjectBeforeClaim()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("interrupted-project-link",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Editing;
        run.ProjectId = "interrupted-project";run.LatestExportTaskId = "previous-export";
        run.DeploymentSlug = "synthetic-export-scope";run.Scenes[0].VideoUrl = "https://synthetic.invalid/existing.mp4";
        await test.SaveRunAsync(run);
        await test.Context.VideoExportTasks.InsertOneAsync(new VideoExportTask { Id = run.LatestExportTaskId,
            RunId = run.Id,ProjectId = run.ProjectId,OwnerAdminId = test.OwnerId,AppKey = run.AppKey,
            Status = VideoExportTaskStatus.Failed,DeploymentSlug = run.DeploymentSlug });
        await test.Context.VideoProjects.InsertOneAsync(new VideoProject { Id = run.ProjectId,
            OwnerAdminId = test.OwnerId,AppKey = run.AppKey,LatestRunId = run.Id,
            LatestExportTaskId = run.LatestExportTaskId,Status = VideoProjectStatus.Editing });
        var actualRuns = test.Context.VideoGenRuns;var actualTasks = test.Context.VideoExportTasks;var actualProjects = test.Context.VideoProjects;
        var projects = new Mock<IMongoCollection<VideoProject>>(MockBehavior.Strict);
        projects.SetupGet(x => x.DocumentSerializer).Returns(actualProjects.DocumentSerializer);
        projects.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<VideoProject>>(),It.IsAny<FindOptions<VideoProject,VideoProject>>(),It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoProject> f,FindOptions<VideoProject,VideoProject> o,CancellationToken c) => actualProjects.FindAsync(f,o,c));
        var writes = 0;
        projects.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<VideoProject>>(),It.IsAny<UpdateDefinition<VideoProject>>(),It.IsAny<UpdateOptions>(),It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoProject> f,UpdateDefinition<VideoProject> u,UpdateOptions o,CancellationToken c) =>
                ++writes == 1 ? Task.FromException<UpdateResult>(new IOException("synthetic-project-link-interruption")) : actualProjects.UpdateOneAsync(f,u,o,c));
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<VideoGenRun>("video_gen_runs",null)).Returns(actualRuns);
        database.Setup(x => x.GetCollection<VideoExportTask>("video_export_tasks",null)).Returns(actualTasks);
        database.Setup(x => x.GetCollection<VideoProject>("video_projects",null)).Returns(projects.Object);
        typeof(MongoDbContext).GetField("_database",BindingFlags.NonPublic|BindingFlags.Instance)!.SetValue(test.Context,database.Object);
        var service = test.CreateService();service.ExportDeploymentScope = run.DeploymentSlug;
        await Assert.ThrowsAsync<IOException>(() => service.RequestExportAsync(run.Id,test.OwnerId,run.AppKey));
        var newTask = await actualTasks.Find(x => x.Id != run.LatestExportTaskId).SingleAsync();
        Assert.Equal(newTask.Id,(await actualRuns.Find(x => x.Id == run.Id).SingleAsync()).LatestExportTaskId);
        using var worker = test.CreateWorker();worker.QueueDeploymentScope = run.DeploymentSlug;
        Assert.Equal(newTask.Id,(await worker.ClaimExportTaskAsync(default))!.Id);
        Assert.Equal(newTask.Id,(await actualProjects.Find(x => x.Id == run.ProjectId).SingleAsync()).LatestExportTaskId);
        Assert.Equal(VideoProjectStatus.Rendering,(await actualProjects.Find(x => x.Id == run.ProjectId).SingleAsync()).Status);
        Assert.Equal(2,await actualTasks.CountDocumentsAsync(FilterDefinition<VideoExportTask>.Empty));
        Assert.Empty(test.AssetStorage.Invocations);Assert.Empty(test.VideoClient.Invocations);
    }

    [Fact]
    public async Task ExportHolder_LateLinkNeverReopensProjectAlreadyCompletedBySameTask()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("late-project-link",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Editing;
        run.ProjectId = "late-link-project";run.DeploymentSlug = "synthetic-export-scope";
        run.Scenes[0].VideoUrl = "https://synthetic.invalid/existing.mp4";await test.SaveRunAsync(run);
        await test.Context.VideoProjects.InsertOneAsync(new VideoProject { Id = run.ProjectId,
            OwnerAdminId = test.OwnerId,AppKey = run.AppKey,LatestRunId = run.Id,Status = VideoProjectStatus.Editing });
        var actualRuns = test.Context.VideoGenRuns;var actualTasks = test.Context.VideoExportTasks;var actualProjects = test.Context.VideoProjects;
        var projects = new Mock<IMongoCollection<VideoProject>>(MockBehavior.Strict);
        projects.SetupGet(x => x.DocumentSerializer).Returns(actualProjects.DocumentSerializer);
        var reads = 0;
        projects.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<VideoProject>>(),It.IsAny<FindOptions<VideoProject,VideoProject>>(),It.IsAny<CancellationToken>()))
            .Returns(async (FilterDefinition<VideoProject> f,FindOptions<VideoProject,VideoProject> o,CancellationToken c) => {
                if (++reads == 1)
                {
                    using var worker = test.CreateWorker();worker.QueueDeploymentScope = run.DeploymentSlug;
                    var claimed = (await worker.ClaimExportTaskAsync(default))!;
                    var linked = await actualRuns.Find(x => x.Id == run.Id).SingleAsync();
                    Assert.True(await worker.RecordCompletedExportAsync(linked,claimed,
                        new PrdAgent.Infrastructure.Services.AssetStorage.StoredAsset(new string('a',64),
                            "https://synthetic.invalid/recorded-output.mp4",3,"video/mp4"),null));
                    Assert.True(await worker.ReconcileCompletedExportAsync(claimed,default));
                }
                return await actualProjects.FindAsync(f,o,c);
            });
        projects.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<VideoProject>>(),It.IsAny<UpdateDefinition<VideoProject>>(),It.IsAny<UpdateOptions>(),It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoProject> f,UpdateDefinition<VideoProject> u,UpdateOptions o,CancellationToken c) => actualProjects.UpdateOneAsync(f,u,o,c));
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<VideoGenRun>("video_gen_runs",null)).Returns(actualRuns);
        database.Setup(x => x.GetCollection<VideoExportTask>("video_export_tasks",null)).Returns(actualTasks);
        database.Setup(x => x.GetCollection<VideoProject>("video_projects",null)).Returns(projects.Object);
        typeof(MongoDbContext).GetField("_database",BindingFlags.NonPublic|BindingFlags.Instance)!.SetValue(test.Context,database.Object);
        var service = test.CreateService();service.ExportDeploymentScope = run.DeploymentSlug;
        var task = await service.RequestExportAsync(run.Id,test.OwnerId,run.AppKey);
        Assert.Equal(VideoGenRunStatus.Completed,(await actualRuns.Find(x => x.Id == run.Id).SingleAsync()).Status);
        var completed = await actualProjects.Find(x => x.Id == run.ProjectId).SingleAsync();
        Assert.Equal(task.Id,completed.LatestExportTaskId);Assert.Equal(VideoProjectStatus.Completed,completed.Status);
        Assert.Equal(VideoExportTaskStatus.Completed,(await actualTasks.Find(x => x.Id == task.Id).SingleAsync()).Status);
        Assert.Empty(test.AssetStorage.Invocations);Assert.Empty(test.VideoClient.Invocations);
    }

    [Fact]
    public async Task ExportHolder_LosingQueuedReaderNeverReopensTaskAlreadyFailedByWinner()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("stale-queued-reader",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Editing;
        run.DeploymentSlug = "synthetic-export-scope";run.Scenes[0].VideoUrl = "https://synthetic.invalid/existing.mp4";
        await test.SaveRunAsync(run);
        var task = new VideoExportTask { Id = "stale-reader-task",RunId = run.Id,OwnerAdminId = test.OwnerId,
            AppKey = run.AppKey,DeploymentSlug = run.DeploymentSlug };
        await test.Context.VideoExportTasks.InsertOneAsync(task);
        var actualRuns = test.Context.VideoGenRuns;var actualTasks = test.Context.VideoExportTasks;var actualProjects = test.Context.VideoProjects;
        var tasks = new Mock<IMongoCollection<VideoExportTask>>(MockBehavior.Strict);
        tasks.SetupGet(x => x.DocumentSerializer).Returns(actualTasks.DocumentSerializer);
        tasks.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<VideoExportTask>>(),It.IsAny<FindOptions<VideoExportTask,BsonDocument>>(),It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoExportTask> f,FindOptions<VideoExportTask,BsonDocument> o,CancellationToken c) => actualTasks.FindAsync(f,o,c));
        var reads = 0;
        tasks.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<VideoExportTask>>(),It.IsAny<FindOptions<VideoExportTask,VideoExportTask>>(),It.IsAny<CancellationToken>()))
            .Returns(async (FilterDefinition<VideoExportTask> f,FindOptions<VideoExportTask,VideoExportTask> o,CancellationToken c) => {
                var stale = await actualTasks.FindAsync(f,o,c);
                if (++reads == 1)
                {
                    using var winner = test.CreateWorker();winner.QueueDeploymentScope = run.DeploymentSlug;
                    var claimed = (await winner.ClaimExportTaskAsync(default))!;Assert.NotNull(claimed);
                    var linked = await actualRuns.Find(x => x.Id == run.Id).SingleAsync();
                    await (Task)typeof(VideoGenRunWorker).GetMethod("FailExportAsync",BindingFlags.Instance|BindingFlags.NonPublic)!
                        .Invoke(winner,new object?[] {linked,"synthetic-muted-track",claimed.Id,claimed})!;
                    Assert.Equal(VideoGenRunStatus.Editing,(await actualRuns.Find(x => x.Id == run.Id).SingleAsync()).Status);
                }
                return stale;
            });
        tasks.Setup(x => x.FindOneAndUpdateAsync(It.IsAny<FilterDefinition<VideoExportTask>>(),It.IsAny<UpdateDefinition<VideoExportTask>>(),
            It.IsAny<FindOneAndUpdateOptions<VideoExportTask,VideoExportTask>>(),It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoExportTask> f,UpdateDefinition<VideoExportTask> u,FindOneAndUpdateOptions<VideoExportTask,VideoExportTask> o,CancellationToken c) => actualTasks.FindOneAndUpdateAsync(f,u,o,c));
        tasks.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<VideoExportTask>>(),It.IsAny<UpdateDefinition<VideoExportTask>>(),It.IsAny<UpdateOptions>(),It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoExportTask> f,UpdateDefinition<VideoExportTask> u,UpdateOptions o,CancellationToken c) => actualTasks.UpdateOneAsync(f,u,o,c));
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<VideoGenRun>("video_gen_runs",null)).Returns(actualRuns);
        database.Setup(x => x.GetCollection<VideoProject>("video_projects",null)).Returns(actualProjects);
        database.Setup(x => x.GetCollection<VideoExportTask>("video_export_tasks",null)).Returns(tasks.Object);
        typeof(MongoDbContext).GetField("_database",BindingFlags.NonPublic|BindingFlags.Instance)!.SetValue(test.Context,database.Object);
        using var loser = test.CreateWorker();loser.QueueDeploymentScope = run.DeploymentSlug;
        Assert.Null(await loser.ClaimExportTaskAsync(default));
        Assert.Equal(VideoExportTaskStatus.Failed,(await actualTasks.Find(x => x.Id == task.Id).SingleAsync()).Status);
        Assert.Equal(VideoGenRunStatus.Editing,(await actualRuns.Find(x => x.Id == run.Id).SingleAsync()).Status);
        Assert.Empty(test.AssetStorage.Invocations);Assert.Empty(test.VideoClient.Invocations);
    }

    [Fact]
    public async Task ExportHolder_LateParentProgressCannotCrossNewHolderFence()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("late-parent-progress",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Editing;
        run.DeploymentSlug = "synthetic-export-scope";run.Scenes[0].VideoUrl = "https://synthetic.invalid/existing.mp4";
        await test.SaveRunAsync(run);
        await test.Context.VideoExportTasks.InsertOneAsync(new VideoExportTask { Id = "parent-progress-task",RunId = run.Id,
            OwnerAdminId = test.OwnerId,AppKey = run.AppKey,DeploymentSlug = run.DeploymentSlug });
        using var original = test.CreateWorker();original.QueueDeploymentScope = run.DeploymentSlug;
        var first = (await original.ClaimExportTaskAsync(default))!;
        var originalRun = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        var actualRuns = test.Context.VideoGenRuns;var actualTasks = test.Context.VideoExportTasks;
        var tasks = new Mock<IMongoCollection<VideoExportTask>>(MockBehavior.Strict);
        tasks.SetupGet(x => x.DocumentSerializer).Returns(actualTasks.DocumentSerializer);
        tasks.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<VideoExportTask>>(),It.IsAny<FindOptions<VideoExportTask,VideoExportTask>>(),It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoExportTask> f,FindOptions<VideoExportTask,VideoExportTask> o,CancellationToken c) => actualTasks.FindAsync(f,o,c));
        tasks.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<VideoExportTask>>(),It.IsAny<FindOptions<VideoExportTask,BsonDocument>>(),It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoExportTask> f,FindOptions<VideoExportTask,BsonDocument> o,CancellationToken c) => actualTasks.FindAsync(f,o,c));
        tasks.Setup(x => x.FindOneAndUpdateAsync(It.IsAny<FilterDefinition<VideoExportTask>>(),It.IsAny<UpdateDefinition<VideoExportTask>>(),
            It.IsAny<FindOneAndUpdateOptions<VideoExportTask,VideoExportTask>>(),It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoExportTask> f,UpdateDefinition<VideoExportTask> u,FindOneAndUpdateOptions<VideoExportTask,VideoExportTask> o,CancellationToken c) => actualTasks.FindOneAndUpdateAsync(f,u,o,c));
        tasks.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<VideoExportTask>>(),It.IsAny<UpdateDefinition<VideoExportTask>>(),It.IsAny<UpdateOptions>(),It.IsAny<CancellationToken>()))
            .Returns(async (FilterDefinition<VideoExportTask> f,UpdateDefinition<VideoExportTask> u,UpdateOptions o,CancellationToken c) => {
                var written = await actualTasks.UpdateOneAsync(f,u,o,c);
                var fields = u.Render(new RenderArgs<VideoExportTask>(actualTasks.DocumentSerializer,MongoDB.Bson.Serialization.BsonSerializer.SerializerRegistry));
                if (written.MatchedCount == 1 && fields.ToJson().Contains("old-progress",StringComparison.Ordinal))
                {
                    await actualTasks.UpdateOneAsync(x => x.Id == first.Id,Builders<VideoExportTask>.Update.Set(x => x.WorkerLeaseExpiresAt,DateTime.UtcNow.AddMinutes(-2)));
                    using var current = test.CreateWorker();current.QueueDeploymentScope = run.DeploymentSlug;
                    Assert.True(await current.RecoverExpiredExportHolderAsync(default));
                    var next = (await current.ClaimExportTaskAsync(default))!;Assert.NotEqual(first.WorkerLeaseId,next.WorkerLeaseId);
                    var currentRun = await actualRuns.Find(x => x.Id == run.Id).SingleAsync();
                    await (Task)typeof(VideoGenRunWorker).GetMethod("UpdateExportProgressAsync",BindingFlags.Instance|BindingFlags.NonPublic)!
                        .Invoke(current,new object[] {currentRun,next,"new-progress",70})!;
                }
                return written;
            });
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<VideoGenRun>("video_gen_runs",null)).Returns(actualRuns);
        database.Setup(x => x.GetCollection<VideoExportTask>("video_export_tasks",null)).Returns(tasks.Object);
        typeof(MongoDbContext).GetField("_database",BindingFlags.NonPublic|BindingFlags.Instance)!.SetValue(test.Context,database.Object);
        await Assert.ThrowsAsync<OperationCanceledException>(() => (Task)typeof(VideoGenRunWorker)
            .GetMethod("UpdateExportProgressAsync",BindingFlags.Instance|BindingFlags.NonPublic)!
            .Invoke(original,new object[] {originalRun,first,"old-progress",10})!);
        var saved = await actualRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal("new-progress",saved.CurrentPhase);Assert.Equal(70,saved.PhaseProgress);
        Assert.NotEqual(first.WorkerLeaseId,saved.ExportHolderLeaseId);
        Assert.Empty(test.AssetStorage.Invocations);Assert.Empty(test.VideoClient.Invocations);
    }

    [Fact]
    [Trait("Category","Manual")]
    public async Task ExportHolder_LostAuthorityWaitsForOnlyItsOwnChildToExit()
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            { FileName = "/bin/sleep",ArgumentList = { "60" },UseShellExecute = false,RedirectStandardOutput = true,RedirectStandardError = true })!;
        using var stop = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        var method = typeof(VideoGenRunWorker).GetMethod("WaitOwnedExportProcessAsync",BindingFlags.Static|BindingFlags.NonPublic)!;
        try
        {
            var wait = (Task<(string Output,string Error)>)method.Invoke(null,new object?[] {process,stop.Token,null})!;
            await Assert.ThrowsAsync<OperationCanceledException>(async () => await wait);
            Assert.True(process.HasExited);
        }
        finally { if (!process.HasExited) { process.Kill(entireProcessTree:true);await process.WaitForExitAsync(); } }
    }

}
