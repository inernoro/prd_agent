using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Infrastructure.Database;
using Moq;
using System.Reflection;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public partial class VideoSceneConcurrencyTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExportCompletionRecovery_ReconcilesPersistedTaskRunAndProject(bool runAlreadyCompleted)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("export-completion-recovery", test.OwnerId, SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;
        run.Status = runAlreadyCompleted ? VideoGenRunStatus.Completed : VideoGenRunStatus.Rendering;
        run.DeploymentSlug = "synthetic-export-scope";
        run.ProjectId = "export-recovery-project";
        run.LatestExportTaskId = "export-recovery-task";
        await test.SaveRunAsync(run);
        await test.Context.VideoProjects.InsertOneAsync(new VideoProject { Id = run.ProjectId,
            OwnerAdminId = test.OwnerId, AppKey = run.AppKey, LatestRunId = run.Id,
            LatestExportTaskId = run.LatestExportTaskId, Status = VideoProjectStatus.Rendering });
        var task = new VideoExportTask { Id = run.LatestExportTaskId, RunId = run.Id,
            ProjectId = run.ProjectId, AppKey = run.AppKey, OwnerAdminId = test.OwnerId,
            Status = VideoExportTaskStatus.Completed, OutputUrl = "https://synthetic.invalid/existing-output.mp4",
            EndedAt = DateTime.UtcNow.AddMinutes(-1) };
        // 模拟已持久化回执而下一次进程未运行；不用内存假响应或真实对象/供应商。
        var receipt = task.ToBsonDocument();
        receipt["DeploymentSlug"] = run.DeploymentSlug; receipt["OutputSha256"] = new string('a', 64); receipt["TotalCost"] = BsonNull.Value;
        await test.Context.Database.GetCollection<BsonDocument>("video_export_tasks").InsertOneAsync(receipt);
        using var worker = test.CreateWorker(); worker.QueueDeploymentScope = run.DeploymentSlug;
        await worker.StartAsync(default);
        try
        {
            var until = DateTime.UtcNow.AddSeconds(3);
            while (DateTime.UtcNow < until)
            {
                var project = await test.Context.VideoProjects.Find(x => x.Id == run.ProjectId).SingleAsync();
                if (project.Status == VideoProjectStatus.Completed) break;
                await Task.Delay(40);
            }
        }
        finally { await worker.StopAsync(default); }
        var stored = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        var savedProject = await test.Context.VideoProjects.Find(x => x.Id == run.ProjectId).SingleAsync();
        Assert.Equal(VideoGenRunStatus.Completed, stored.Status);
        Assert.Equal(task.OutputUrl, stored.VideoAssetUrl);
        Assert.Equal(new string('a', 64), stored.VideoAssetSha256);
        Assert.Null(stored.DirectVideoCost);
        Assert.Equal(VideoProjectStatus.Completed, savedProject.Status);
        var savedTask = await test.Context.Database.GetCollection<BsonDocument>("video_export_tasks")
            .Find(new BsonDocument("_id", task.Id)).SingleAsync();
        Assert.True(savedTask.TryGetValue("RunReconciledAt", out var reconciled) && reconciled.IsValidDateTime);
        Assert.Empty(test.VideoClient.Invocations);
        Assert.Empty(test.AssetStorage.Invocations);
    }
    [Theory]
    [InlineData("cancelled")]
    [InlineData("deleted")]
    [InlineData("newer-export")]
    [InlineData("foreign-owner")]
    [InlineData("foreign-app")]
    [InlineData("foreign-project")]
    [InlineData("other-deployment")]
    [InlineData("completed-other-output")]
    public async Task ExportRecovery_MustNotOverwriteCancelledDeletedNewerOrForeignRun(string variant)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("export-protected-parent", test.OwnerId, SceneItemStatus.Done);
        run.Status = VideoGenRunStatus.Rendering; run.Mode = VideoGenMode.Storyboard;
        run.ProjectId = "protected-project"; run.LatestExportTaskId = "protected-task";
        run.DeploymentSlug = "synthetic-export-scope";
        var task = new VideoExportTask { Id = run.LatestExportTaskId, RunId = run.Id, ProjectId = run.ProjectId,
            OwnerAdminId = run.OwnerAdminId, AppKey = run.AppKey, DeploymentSlug = run.DeploymentSlug,
            Status = VideoExportTaskStatus.Completed, OutputUrl = "https://synthetic.invalid/completed.mp4",
            OutputSha256 = new string('a',64), TotalCost = null, EndedAt = DateTime.UtcNow };
        switch (variant)
        {
            case "cancelled": run.CancelRequested = true; run.Status = VideoGenRunStatus.Cancelled; break;
            case "deleted": run.DeletionRequestedAt = DateTime.UtcNow; break;
            case "newer-export": run.LatestExportTaskId = "newer-task"; break;
            case "foreign-owner": run.OwnerAdminId = "different-owner"; break;
            case "foreign-app": run.AppKey = "visual-agent"; break;
            case "foreign-project": run.ProjectId = "other-project"; break;
            case "other-deployment": task.DeploymentSlug = "other-deployment"; break;
            case "completed-other-output": run.Status = VideoGenRunStatus.Completed;
                run.VideoAssetUrl = "https://synthetic.invalid/newer.mp4"; run.VideoAssetSha256 = new string('b',64); break;
        }
        await test.SaveRunAsync(run); await test.Context.VideoExportTasks.InsertOneAsync(task);
        var before = (await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).ToBsonDocument();
        using var worker = test.CreateWorker(); worker.QueueDeploymentScope = "synthetic-export-scope";
        await worker.RecoverCompletedExportTaskAsync(default);
        Assert.Equal(before, (await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).ToBsonDocument());
        Assert.Equal(task.OutputUrl, (await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync()).OutputUrl);
        Assert.Empty(test.AssetStorage.Invocations); Assert.Empty(test.VideoClient.Invocations);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0.0)]
    [InlineData(0.43)]
    public async Task ExportCompletion_PersistsReceiptBeforeRunAndReconcilesIdempotently(double? cost)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("export-durable-receipt", test.OwnerId, SceneItemStatus.Done);
        run.Status = VideoGenRunStatus.Rendering; run.Mode = VideoGenMode.Storyboard;
        run.ProjectId = "durable-project"; run.LatestExportTaskId = "durable-task";
        run.DeploymentSlug = "synthetic-export-scope";
        var task = new VideoExportTask { Id = run.LatestExportTaskId, RunId = run.Id, ProjectId = run.ProjectId,
            OwnerAdminId = run.OwnerAdminId, AppKey = run.AppKey, DeploymentSlug = run.DeploymentSlug,
            Status = VideoExportTaskStatus.Processing, StartedAt = DateTime.UtcNow.AddMinutes(-2) };
        await test.SaveRunAsync(run); await test.Context.VideoExportTasks.InsertOneAsync(task);
        await test.Context.VideoProjects.InsertOneAsync(new VideoProject { Id = run.ProjectId,
            OwnerAdminId = test.OwnerId, AppKey = run.AppKey, LatestRunId = run.Id,
            LatestExportTaskId = task.Id, Status = VideoProjectStatus.Rendering });
        using var worker = test.CreateWorker(); worker.QueueDeploymentScope = run.DeploymentSlug;
        var asset = new StoredAsset(new string('a',64), "https://synthetic.invalid/saved-existing.mp4", 3, "video/mp4");
        Assert.True(await worker.RecordCompletedExportAsync(run, task, asset, cost));
        var receipt = await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync();
        Assert.Equal(VideoExportTaskStatus.Completed, receipt.Status); Assert.Equal(asset.Sha256, receipt.OutputSha256);
        Assert.Null(receipt.RunReconciledAt); Assert.Equal(cost, receipt.TotalCost);
        Assert.Equal(VideoGenRunStatus.Rendering, (await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).Status);
        Assert.True(await worker.RecoverCompletedExportTaskAsync(default));
        Assert.False(await worker.RecoverCompletedExportTaskAsync(default));
        Assert.Equal(cost, (await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).DirectVideoCost);
        Assert.Equal(VideoProjectStatus.Completed, (await test.Context.VideoProjects.Find(x => x.Id == run.ProjectId).SingleAsync()).Status);
        Assert.Empty(test.AssetStorage.Invocations); Assert.Empty(test.VideoClient.Invocations);
    }

    [Fact]
    public async Task ExportRecovery_ProjectWriteFailureKeepsReceiptPendingAndNextAttemptCompletes()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("export-project-failure", test.OwnerId, SceneItemStatus.Done);
        run.Status = VideoGenRunStatus.Rendering; run.Mode = VideoGenMode.Storyboard;
        run.ProjectId = "project-failure"; run.LatestExportTaskId = "task-failure";
        run.DeploymentSlug = "synthetic-export-scope";
        var task = new VideoExportTask { Id = run.LatestExportTaskId, RunId = run.Id, ProjectId = run.ProjectId,
            OwnerAdminId = run.OwnerAdminId, AppKey = run.AppKey, DeploymentSlug = run.DeploymentSlug,
            Status = VideoExportTaskStatus.Completed, OutputUrl = "https://synthetic.invalid/existing-output.mp4",
            OutputSha256 = new string('a',64), EndedAt = DateTime.UtcNow };
        await test.SaveRunAsync(run); await test.Context.VideoExportTasks.InsertOneAsync(task);
        await test.Context.VideoProjects.InsertOneAsync(new VideoProject { Id = run.ProjectId,
            OwnerAdminId = test.OwnerId, AppKey = run.AppKey, LatestRunId = run.Id,
            LatestExportTaskId = task.Id, Status = VideoProjectStatus.Rendering });
        var actualProjects = test.Context.VideoProjects;
        var projects = new Mock<IMongoCollection<VideoProject>>(MockBehavior.Strict);
        projects.SetupGet(x => x.DocumentSerializer).Returns(actualProjects.DocumentSerializer);
        projects.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<VideoProject>>(),
            It.IsAny<FindOptions<VideoProject,VideoProject>>(), It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoProject> f, FindOptions<VideoProject,VideoProject> o, CancellationToken c) => actualProjects.FindAsync(f,o,c));
        var calls = 0;
        projects.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<VideoProject>>(),
            It.IsAny<UpdateDefinition<VideoProject>>(), It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>()))
            .Returns((FilterDefinition<VideoProject> f, UpdateDefinition<VideoProject> u, UpdateOptions o, CancellationToken c) =>
                ++calls == 1 ? Task.FromException<UpdateResult>(new IOException("synthetic-project-write-failure"))
                : actualProjects.UpdateOneAsync(f,u,o,c));
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<VideoProject>("video_projects", null)).Returns(projects.Object);
        database.Setup(x => x.GetCollection<VideoGenRun>("video_gen_runs", null)).Returns(test.Context.VideoGenRuns);
        database.Setup(x => x.GetCollection<VideoExportTask>("video_export_tasks", null)).Returns(test.Context.VideoExportTasks);
        typeof(MongoDbContext).GetField("_database", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(test.Context,database.Object);
        using var worker = test.CreateWorker(); worker.QueueDeploymentScope = run.DeploymentSlug;
        await Assert.ThrowsAsync<IOException>(() => worker.RecoverCompletedExportTaskAsync(default));
        Assert.Null((await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync()).RunReconciledAt);
        Assert.Equal(VideoGenRunStatus.Completed, (await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).Status);
        Assert.True(await worker.RecoverCompletedExportTaskAsync(default));
        Assert.Equal(2,calls); Assert.NotNull((await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync()).RunReconciledAt);
        Assert.Equal(VideoProjectStatus.Completed, (await actualProjects.Find(x => x.Id == run.ProjectId).SingleAsync()).Status);
        Assert.Empty(test.AssetStorage.Invocations); Assert.Empty(test.VideoClient.Invocations);
    }

    [Fact]
    public async Task ExportRequestAndClaim_PreserveOriginalRunDeploymentAndDoNotClaimAnotherDeployment()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("export-create-scope", test.OwnerId, SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard; run.Status = VideoGenRunStatus.Editing;
        run.DeploymentSlug = "synthetic-export-scope"; run.Scenes[0].VideoUrl = "https://synthetic.invalid/scene.mp4";
        await test.SaveRunAsync(run);
        var task = await test.CreateService().RequestExportAsync(run.Id,test.OwnerId,run.AppKey);
        Assert.Equal(run.DeploymentSlug,task.DeploymentSlug);
        using var foreign = test.CreateWorker(); foreign.QueueDeploymentScope = "different-deployment";
        Assert.Null(await foreign.ClaimExportTaskAsync(default));
        Assert.Equal(VideoExportTaskStatus.Queued,(await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync()).Status);
        using var current = test.CreateWorker(); current.QueueDeploymentScope = run.DeploymentSlug;
        Assert.Equal(task.Id,(await current.ClaimExportTaskAsync(default))!.Id);
        Assert.Null(await current.ClaimExportTaskAsync(default));
        Assert.Empty(test.VideoClient.Invocations); Assert.Empty(test.AssetStorage.Invocations);
    }

    [Fact]
    public async Task ExportCompletion_RejectsReplacedProcessingAttemptAndKeepsPreviousReceipt()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("export-attempt-fence",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard; run.Status = VideoGenRunStatus.Rendering;
        run.ProjectId = "fence-project"; run.DeploymentSlug = "synthetic-export-scope";
        var old = new VideoExportTask { Id = "fenced-task",RunId = run.Id,OwnerAdminId = test.OwnerId,
            AppKey = run.AppKey,ProjectId = run.ProjectId,DeploymentSlug = run.DeploymentSlug,
            Status = VideoExportTaskStatus.Processing,StartedAt = DateTime.UtcNow.AddMinutes(-3) };
        await test.SaveRunAsync(run);await test.Context.VideoExportTasks.InsertOneAsync(old);
        await test.Context.VideoExportTasks.UpdateOneAsync(x => x.Id == old.Id,
            Builders<VideoExportTask>.Update.Set(x => x.StartedAt,DateTime.UtcNow));
        using var worker = test.CreateWorker();worker.QueueDeploymentScope = run.DeploymentSlug;
        Assert.False(await worker.RecordCompletedExportAsync(run,old,
            new StoredAsset(new string('a',64),"https://synthetic.invalid/late.mp4",3,"video/mp4"),null));
        var saved = await test.Context.VideoExportTasks.Find(x => x.Id == old.Id).SingleAsync();
        Assert.Equal(VideoExportTaskStatus.Processing,saved.Status);Assert.Null(saved.OutputUrl);
        Assert.Empty(test.AssetStorage.Invocations);Assert.Empty(test.VideoClient.Invocations);
    }

    [Fact]
    public async Task ExportWorker_UsesScopedParentAndDoesNotStartWorkForCancelledRun()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("cancelled-export-parent",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Cancelled;run.CancelRequested = true;
        run.DeploymentSlug = "synthetic-export-scope";run.ProjectId = null;
        await test.SaveRunAsync(run);
        var task = new VideoExportTask { Id = "cancelled-export-task",RunId = run.Id,OwnerAdminId = test.OwnerId,
            AppKey = run.AppKey,ProjectId = string.Empty,DeploymentSlug = run.DeploymentSlug };
        await test.Context.VideoExportTasks.InsertOneAsync(task);
        using var worker = test.CreateWorker();worker.QueueDeploymentScope = run.DeploymentSlug;
        await worker.StartAsync(default);
        try
        {
            var until = DateTime.UtcNow.AddSeconds(3);
            while (DateTime.UtcNow < until)
            {
                var current = await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync();
                if (current.Status != VideoExportTaskStatus.Queued && current.Status != VideoExportTaskStatus.Processing) break;
                await Task.Delay(30);
            }
        }
        finally { await worker.StopAsync(default); }
        Assert.Equal(VideoExportTaskStatus.Cancelled,(await test.Context.VideoExportTasks.Find(x => x.Id == task.Id).SingleAsync()).Status);
        Assert.Equal(VideoGenRunStatus.Cancelled,(await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync()).Status);
        Assert.Empty(test.VideoClient.Invocations);Assert.Empty(test.AssetStorage.Invocations);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public async Task ExportCompletion_ActualServiceWithoutProjectProducesRecoverableReceipt(string? projectId)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = NewRun("export-no-project",test.OwnerId,SceneItemStatus.Done);
        run.Mode = VideoGenMode.Storyboard;run.Status = VideoGenRunStatus.Editing;
        run.ProjectId = projectId;run.DeploymentSlug = "synthetic-export-scope";
        run.Scenes[0].VideoUrl = "https://synthetic.invalid/already-generated.mp4";
        await test.SaveRunAsync(run);
        var task = await test.CreateService().RequestExportAsync(run.Id,test.OwnerId,run.AppKey);
        Assert.Equal(string.Empty,task.ProjectId);
        using var worker = test.CreateWorker();worker.QueueDeploymentScope = run.DeploymentSlug;
        task = (await worker.ClaimExportTaskAsync(default))!;
        Assert.True(await worker.RecordCompletedExportAsync(run,task,
            new StoredAsset(new string('a',64),"https://synthetic.invalid/export-no-project.mp4",3,"video/mp4"),null));
        Assert.True(await worker.RecoverCompletedExportTaskAsync(default));
        var saved = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal(VideoGenRunStatus.Completed,saved.Status);
        Assert.Equal("https://synthetic.invalid/export-no-project.mp4",saved.VideoAssetUrl);
        Assert.Empty(test.VideoClient.Invocations);Assert.Empty(test.AssetStorage.Invocations);
    }

}
