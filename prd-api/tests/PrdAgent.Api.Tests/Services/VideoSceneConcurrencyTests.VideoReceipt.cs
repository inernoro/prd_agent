using System.Reflection;
using System.Runtime.CompilerServices;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using PrdAgent.Core.Services;
using MongoDB.Bson.Serialization;
using PrdAgent.Infrastructure.Database;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public partial class VideoSceneConcurrencyTests
{
    private static VideoGenRun ReceiptRun(string id, string owner)
    {
        var run = NewRun(id, owner, SceneItemStatus.Draft);
        run.Mode = VideoGenMode.Direct; run.Status = VideoGenRunStatus.Rendering;
        run.DirectVideoJobId = "synthetic-original-job"; run.DirectVideoModel = "synthetic-original-model";
        run.DirectVideoOfferingId = "synthetic-original-offering";
        return run;
    }

    [Theory]
    [InlineData("completed", null)]
    [InlineData("failed", 0.0)]
    [InlineData("cancelled", 0.12)]
    [InlineData("expired", null)]
    public async Task CancelledReceipt_PreservesTerminalAndNullableCost_WithoutOutputOrNewTask(string status, double? cost)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = ReceiptRun("receipt-terminal", test.OwnerId);
        var (coordinator, generation) = await test.SaveAuthorizedRunAsync(run);
        await using var old = generation;
        Assert.True(await test.CreateService().CancelRunAsync(run.Id, test.OwnerId, run.AppKey));
        var cancelled = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        var endedAt = cancelled.EndedAt;
        test.VideoClient.Setup(x => x.GetStatusForOfferingAsync(It.IsAny<string>(), run.DirectVideoJobId!,
            run.DirectVideoModel, run.DirectVideoOfferingId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new OpenRouterVideoStatus { Status = status, Cost = cost, VideoUrl = "https://synthetic.invalid/never-download" });
        using var worker = test.CreateWorker(coordinator);
        await (Task)typeof(VideoGenRunWorker).GetMethod("ProcessDirectVideoGenAsync", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(worker, [cancelled])!;
        var stored = await test.Context.VideoGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal(VideoGenRunStatus.Cancelled, stored.Status); Assert.Equal(endedAt, stored.EndedAt);
        Assert.Equal(status, stored.DirectVideoUpstreamStatus); Assert.Equal(cost, stored.DirectVideoCost);
        Assert.NotNull(stored.DirectVideoReconciledAt); Assert.Null(stored.VideoAssetUrl);
        Assert.False(await coordinator.ValidateAsync(old.Proof, true, default));
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => coordinator.AcquireAsync(run.TaskPermitId!, run.Id, default));
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => coordinator.AcquireVideoReceiptAsync(run.TaskPermitId!, run.Id, default));
        test.VideoClient.Verify(x => x.SubmitAsync(It.IsAny<OpenRouterVideoSubmitRequest>(), It.IsAny<CancellationToken>()), Times.Never);
        Assert.Empty(test.AssetStorage.Invocations);
        var permit = await test.Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName).Find(x => x.Id == run.TaskPermitId).SingleAsync();
        Assert.Single(permit.BoundRunIds); Assert.Single(permit.Executions); Assert.Equal(4, permit.MaxCalls); Assert.Equal(0, permit.CallCount);
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("credential")]
    [InlineData("permit")]
    [InlineData("expiry")]
    [InlineData("delete")]
    [InlineData("delete-intent")]
    [InlineData("call-cap")]
    public async Task CancelledReceipt_RevocationAndOriginalLimitsStillDeny(string stop)
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = ReceiptRun("receipt-denial", test.OwnerId);
        var (coordinator, generation) = await test.SaveAuthorizedRunAsync(run);
        await using var old = generation;
        Assert.True(await test.CreateService().CancelRunAsync(run.Id, test.OwnerId, run.AppKey));
        await using var receipt = await coordinator.AcquireVideoReceiptAsync(run.TaskPermitId!, run.Id, default);
        var target = receipt.Identity.VideoReceipt!;
        Assert.True(await coordinator.ValidateVideoReceiptAsync(receipt.Proof, target, false, default));
        Assert.False(await coordinator.ValidateAsync(receipt.Proof, false, default));
        Assert.False(await receipt.TryReleaseForRetryAsync(default));
        var permits = test.Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);
        switch (stop)
        {
            case "actor": await coordinator.ChangeActorAuthorizationAsync(GatewayTenantDefaults.InternalTenantId, test.OwnerId, false, default); break;
            case "credential": await coordinator.RevokeCredentialAsync(GatewayTenantDefaults.InternalTenantId, "synthetic-session", default); break;
            case "permit": await coordinator.RevokeAsync(run.TaskPermitId!, null, default); break;
            case "expiry": await permits.UpdateOneAsync(x => x.Id == run.TaskPermitId, Builders<GatewayTaskPermitRecord>.Update.Set(x => x.ExpiresAt, DateTime.UtcNow.AddSeconds(-1))); break;
            case "delete": await test.Context.VideoGenRuns.DeleteOneAsync(x => x.Id == run.Id); break;
            case "delete-intent": await test.Context.VideoGenRuns.UpdateOneAsync(x => x.Id == run.Id, Builders<VideoGenRun>.Update.Set(x => x.DeletionRequestedAt, DateTime.UtcNow)); break;
            case "call-cap": await permits.UpdateOneAsync(x => x.Id == run.TaskPermitId, Builders<GatewayTaskPermitRecord>.Update.Set(x => x.CallCount, 4)); break;
        }
        // A previously reserved last call may commit a receipt; a new call must never obtain fresh allowance.
        if (stop != "call-cap") Assert.False(await coordinator.ValidateVideoReceiptAsync(receipt.Proof, target, true, default));
        await receipt.DisposeAsync();
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => coordinator.AcquireVideoReceiptAsync(run.TaskPermitId!, run.Id, default));
        Assert.False(await coordinator.ValidateAsync(old.Proof, true, default));
        Assert.Empty(test.VideoClient.Invocations);
    }

    [Fact]
    public async Task CancelledReceipt_IsFencedImmutableAndCannotMutateExecutionOrOtherRuns()
    {
        await using var test = await VideoSceneTestDatabase.CreateAsync();
        var run = ReceiptRun("receipt-fence", test.OwnerId);
        var other = ReceiptRun("receipt-other", test.OwnerId); await test.SaveRunAsync(other);
        var (coordinator, generation) = await test.SaveAuthorizedRunAsync(run);
        await using var old = generation;
        Assert.True(await test.CreateService().CancelRunAsync(run.Id, test.OwnerId, run.AppKey));
        var attempts = await Task.WhenAll(Enumerable.Range(0, 12).Select(async _ =>
        {
            try { return await coordinator.AcquireVideoReceiptAsync(run.TaskPermitId!, run.Id, default); }
            catch (TaskExecutionAdmissionException) { return null; }
        }));
        var winner = Assert.Single(attempts.Where(x => x is not null))!;
        var target = winner.Identity.VideoReceipt!;
        await coordinator.BindVideoReceiptAsync(run.TaskPermitId!, run.Id, target with { JobId = "forged-job" }, GatewayTenantDefaults.InternalTenantId, default);
        Assert.True(await coordinator.ValidateVideoReceiptAsync(winner.Proof, target, false, default));
        Assert.False(await coordinator.ValidateVideoReceiptAsync(winner.Proof, target with { JobId = "forged-job" }, false, default));
        using (TaskExecutionContext.Enter(winner.Identity))
        {
            var filter = Builders<VideoGenRun>.Filter.Eq(x => x.Id, run.Id);
            var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => test.Context.VideoGenRuns.UpdateOneAsync(filter,
                Builders<VideoGenRun>.Update.Set(x => x.Status, VideoGenRunStatus.Completed)));
            Assert.Equal("TASK_VIDEO_RECEIPT_WRITE_DENIED", error.Code);
            await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => test.Context.VideoGenRuns.InsertOneAsync(ReceiptRun("forged-new-run", test.OwnerId)));
            var cross = await test.Context.VideoGenRuns.UpdateOneAsync(x => x.Id == other.Id,
                Builders<VideoGenRun>.Update.Set(x => x.DirectVideoCost, 999));
            Assert.Equal(0, cross.MatchedCount);
            var legitimate = await test.Context.VideoGenRuns.UpdateOneAsync(filter,
                Builders<VideoGenRun>.Update.Set(x => x.DirectVideoCost, 0.43));
            Assert.Equal(1, legitimate.ModifiedCount);
        }
        await winner.DisposeAsync();
        await using var next = await coordinator.AcquireVideoReceiptAsync(run.TaskPermitId!, run.Id, default);
        Assert.True(next.Proof.Fence > winner.Proof.Fence);
        Assert.False(await coordinator.ValidateVideoReceiptAsync(winner.Proof, target, true, default));
        Assert.True(await coordinator.ValidateVideoReceiptAsync(next.Proof, target, true, default));
        Assert.False(await coordinator.ValidateAsync(next.Proof, true, default));
        Assert.Null((await test.Context.VideoGenRuns.Find(x => x.Id == other.Id).SingleAsync()).DirectVideoCost);
    }
    [Theory]
    [Trait("Category", "Unit")]
    [InlineData("complete")]
    [InlineData("no-job")]
    [InlineData("no-model")]
    [InlineData("no-offering")]
    [InlineData("no-permit")]
    [InlineData("delete")]
    public async Task SceneReceiptMock_LifecycleFreezesOnlySubmittedSceneAndRevokesOnDelete(string variant)
    {
        BsonClassMapRegistration.Register();
        var run = new VideoGenRun { Id = "synthetic-parent", OwnerAdminId = "synthetic-owner", AppKey = "video-agent",
            Mode = VideoGenMode.Storyboard, TaskPermitId = "synthetic-root-permit", Status = VideoGenRunStatus.Rendering,
            Scenes = [new VideoGenScene { Index = 0, TaskPermitId = "synthetic-scene-permit", JobId = "recorded-scene-job",
                Model = "recorded-model", OfferingId = "recorded-offering", Status = SceneItemStatus.Polling }] };
        var scene = run.Scenes[0];
        if (variant == "no-job") scene.JobId = null;
        if (variant == "no-model") scene.Model = null;
        if (variant == "no-offering") scene.OfferingId = null;
        if (variant == "no-permit") scene.TaskPermitId = null;
        var coordinator = new Mock<ITaskExecutionCoordinator>(MockBehavior.Strict);
        var bound = new List<(string Permit, string Run, VideoReceiptTarget Target)>();
        var revoked = new List<(string Permit, string Run)>();
        coordinator.Setup(x => x.BindVideoReceiptAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<VideoReceiptTarget>(),
            It.IsAny<string>(), CancellationToken.None)).Callback<string, string, VideoReceiptTarget, string, CancellationToken>(
            (permit, id, target, _, _) => bound.Add((permit, id, target))).Returns(Task.CompletedTask);
        coordinator.Setup(x => x.RevokeVideoReceiptAsync(It.IsAny<string>(), It.IsAny<string>(), CancellationToken.None))
            .Callback<string, string, CancellationToken>((permit, id, _) => revoked.Add((permit, id))).Returns(Task.CompletedTask);
        coordinator.Setup(x => x.RevokeAsync(It.IsAny<string>(), It.IsAny<string>(), CancellationToken.None)).Returns(Task.CompletedTask);
        var rows = new Mock<IMongoCollection<VideoGenRun>>(MockBehavior.Strict);
        rows.SetupGet(x => x.DocumentSerializer).Returns(BsonSerializer.LookupSerializer<VideoGenRun>());
        rows.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<VideoGenRun>>(), It.IsAny<FindOptions<VideoGenRun, VideoGenRun>>(), CancellationToken.None))
            .Returns(() =>
            {
                var cursor = new Mock<IAsyncCursor<VideoGenRun>>(MockBehavior.Strict);
                cursor.SetupGet(x => x.Current).Returns(new[] { run });
                cursor.SetupSequence(x => x.MoveNextAsync(CancellationToken.None)).ReturnsAsync(true).ReturnsAsync(false);
                cursor.Setup(x => x.Dispose());
                return Task.FromResult(cursor.Object);
            });
        rows.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<VideoGenRun>>(), It.IsAny<UpdateDefinition<VideoGenRun>>(),
            It.IsAny<UpdateOptions>(), CancellationToken.None)).ReturnsAsync(new UpdateResult.Acknowledged(1, 1, null));
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<VideoGenRun>("video_gen_runs", null)).Returns(rows.Object);
        var guarded = TaskLifecycleMongoDatabase.Wrap(database.Object, () => coordinator.Object).GetCollection<VideoGenRun>("video_gen_runs");
        var update = variant == "delete" ? Builders<VideoGenRun>.Update.Set(x => x.DeletionRequestedAt, DateTime.UtcNow)
            : Builders<VideoGenRun>.Update.Set(x => x.CancelRequested, true).Set(x => x.Status, VideoGenRunStatus.Cancelled);
        await guarded.UpdateOneAsync(x => x.Id == run.Id, update, cancellationToken: CancellationToken.None);
        if (variant == "complete")
        {
            var binding = Assert.Single(bound);
            Assert.Equal(scene.TaskPermitId, binding.Permit); Assert.Equal(run.Id + "_scene_0", binding.Run);
            Assert.Equal(new VideoReceiptTarget(run.OwnerAdminId, AppCallerRegistry.VideoAgent.VideoGen.Generate,
                scene.JobId!, scene.Model!, scene.OfferingId!), binding.Target);
        }
        else Assert.Empty(bound);
        if (variant == "delete") Assert.Contains((scene.TaskPermitId!, run.Id + "_scene_0"), revoked);
        coordinator.Verify(x => x.RegisterAsync(It.IsAny<GatewayTaskPermitRecord>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [Trait("Category", "Unit")]
    [InlineData("completed", null)]
    [InlineData("failed", 0.12)]
    [InlineData("cancelled", 0.0)]
    [InlineData("expired", null)]
    [InlineData("in_progress", 0.01)]
    public async Task SceneReceiptMock_WorkerWritesOnlyFrozenSceneReceipt(string status, double? cost)
    {
        BsonClassMapRegistration.Register();
        var run = new VideoGenRun { Id = "synthetic-parent", OwnerAdminId = "synthetic-owner", AppKey = "video-agent",
            Mode = VideoGenMode.Storyboard, TaskPermitId = "synthetic-root", Status = VideoGenRunStatus.Cancelled,
            CancelRequested = true, EndedAt = DateTime.UnixEpoch,
            Scenes = [new VideoGenScene { Index = 0, TaskPermitId = "synthetic-scene-permit", JobId = "recorded-scene-job",
                Model = "recorded-model", OfferingId = "recorded-offering", Status = SceneItemStatus.Polling }] };
        var scene = run.Scenes[0]; var executionId = run.Id + "_scene_0";
        var target = new VideoReceiptTarget(run.OwnerAdminId, AppCallerRegistry.VideoAgent.VideoGen.Generate,
            scene.JobId!, scene.Model!, scene.OfferingId!);
        var coordinator = new Mock<ITaskExecutionCoordinator>(MockBehavior.Strict);
        var proof = new TaskExecutionLeaseProof(scene.TaskPermitId!, executionId, "synthetic-owner-token", 7);
        coordinator.Setup(x => x.AcquireVideoReceiptAsync(scene.TaskPermitId!, executionId, CancellationToken.None))
            .ReturnsAsync(() => new TaskExecutionLease(coordinator.Object, proof, borrowed: true, videoReceipt: target));
        coordinator.Setup(x => x.ValidateVideoReceiptAsync(proof, target, false, CancellationToken.None)).ReturnsAsync(true);
        coordinator.Setup(x => x.ReleaseVideoReceiptAsync(proof, target, CancellationToken.None)).ReturnsAsync(true);
        coordinator.Setup(x => x.RevokeVideoReceiptAsync(scene.TaskPermitId!, executionId, CancellationToken.None)).Returns(Task.CompletedTask);
        var rows = new Mock<IMongoCollection<VideoGenRun>>(MockBehavior.Strict);
        rows.SetupGet(x => x.DocumentSerializer).Returns(BsonSerializer.LookupSerializer<VideoGenRun>());
        rows.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<VideoGenRun>>(), It.IsAny<FindOptions<VideoGenRun, VideoGenRun>>(), CancellationToken.None))
            .Returns(() =>
            {
                var cursor = new Mock<IAsyncCursor<VideoGenRun>>(MockBehavior.Strict);
                cursor.SetupGet(x => x.Current).Returns(new[] { run });
                cursor.SetupSequence(x => x.MoveNextAsync(CancellationToken.None)).ReturnsAsync(true).ReturnsAsync(false);
                cursor.Setup(x => x.Dispose()); return Task.FromResult(cursor.Object);
            });
        BsonDocument? written = null; BsonDocument? guardedFilter = null;
        rows.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<VideoGenRun>>(), It.IsAny<UpdateDefinition<VideoGenRun>>(),
                It.IsAny<UpdateOptions>(), CancellationToken.None))
            .Returns((FilterDefinition<VideoGenRun> filter, UpdateDefinition<VideoGenRun> patch, UpdateOptions _, CancellationToken _) =>
            {
                var args = new RenderArgs<VideoGenRun>(BsonSerializer.LookupSerializer<VideoGenRun>(), BsonSerializer.SerializerRegistry);
                written = patch.Render(args).AsBsonDocument; guardedFilter = filter.Render(args).AsBsonDocument;
                return Task.FromResult<UpdateResult>(new UpdateResult.Acknowledged(1, 1, null));
            });
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<VideoGenRun>("video_gen_runs", null)).Returns(rows.Object);
        var context = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(context, TaskLifecycleMongoDatabase.Wrap(database.Object, () => coordinator.Object));
        var client = new Mock<IOpenRouterVideoClient>(MockBehavior.Strict);
        client.Setup(x => x.GetStatusForOfferingAsync(target.AppCallerCode, target.JobId, target.Model, target.OfferingId, CancellationToken.None))
            .ReturnsAsync(new OpenRouterVideoStatus { Status = status, Cost = cost, VideoUrl = "https://synthetic.invalid/never-download" });
        using var services = new ServiceCollection().AddSingleton(client.Object)
            .AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>().BuildServiceProvider();
        var assets = new Mock<IAssetStorage>(MockBehavior.Strict); var events = new Mock<IRunEventStore>(MockBehavior.Strict);
        using var worker = new VideoGenRunWorker(context, services.GetRequiredService<IServiceScopeFactory>(), events.Object,
            assets.Object, NullLogger<VideoGenRunWorker>.Instance, coordinator.Object);
        await (Task)typeof(VideoGenRunWorker).GetMethod("ReconcileCancelledSceneAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(worker, [run, scene])!;
        Assert.NotNull(written); var fields = written!["$set"].AsBsonDocument;
        Assert.Equal(status, fields["Scenes.0.UpstreamStatus"].AsString);
        Assert.Equal(cost, fields["Scenes.0.Cost"].IsBsonNull ? (double?)null : fields["Scenes.0.Cost"].ToDouble());
        Assert.Equal(status != "in_progress", fields.Contains("Scenes.0.ReconciledAt"));
        Assert.All(fields.Names, name => Assert.StartsWith("Scenes.0.", name));
        Assert.NotNull(guardedFilter);
        var guarded = guardedFilter!.ToString();
        Assert.Contains("synthetic-parent", guarded); Assert.Contains("Scenes.0.TaskPermitId", guarded);
        Assert.Contains("synthetic-scene-permit", guarded); Assert.Contains("recorded-scene-job", guarded);
        Assert.Contains("recorded-model", guarded); Assert.Contains("recorded-offering", guarded);
        Assert.Contains("Cancelled", guarded); Assert.Contains("DeletionRequestedAt", guarded);
        Assert.DoesNotContain("synthetic-root", guarded);
        Assert.Equal(VideoGenRunStatus.Cancelled, run.Status); Assert.Equal(DateTime.UnixEpoch, run.EndedAt);
        coordinator.Verify(x => x.RevokeVideoReceiptAsync(scene.TaskPermitId!, executionId, CancellationToken.None),
            status == "in_progress" ? Times.Never() : Times.Once());
        client.Verify(x => x.GetStatusForOfferingAsync(target.AppCallerCode, target.JobId, target.Model, target.OfferingId, CancellationToken.None), Times.Once);
        client.VerifyNoOtherCalls(); assets.VerifyNoOtherCalls(); events.VerifyNoOtherCalls();
    }

    [Theory]
    [Trait("Category", "Unit")]
    [InlineData("Status")]
    [InlineData("Scenes.0.VideoUrl")]
    [InlineData("Scenes.1.Cost")]
    [InlineData("QueueEnteredAt")]
    [InlineData("TaskPermitId")]
    public async Task SceneReceiptMock_GuardDeniesGenerationAndOtherSceneWrites(string field)
    {
        BsonClassMapRegistration.Register();
        var target = new VideoReceiptTarget("synthetic-owner", AppCallerRegistry.VideoAgent.VideoGen.Generate,
            "recorded-scene-job", "recorded-model", "recorded-offering");
        var proof = new TaskExecutionLeaseProof("synthetic-scene-permit", "synthetic-parent_scene_0", "synthetic-token", 7);
        var coordinator = new Mock<ITaskExecutionCoordinator>(MockBehavior.Strict);
        coordinator.Setup(x => x.ValidateVideoReceiptAsync(proof, target, false, CancellationToken.None)).ReturnsAsync(true);
        var rows = new Mock<IMongoCollection<VideoGenRun>>(MockBehavior.Strict);
        rows.SetupGet(x => x.DocumentSerializer).Returns(BsonSerializer.LookupSerializer<VideoGenRun>());
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<VideoGenRun>("video_gen_runs", null)).Returns(rows.Object);
        var guarded = TaskLifecycleMongoDatabase.Wrap(database.Object, () => coordinator.Object).GetCollection<VideoGenRun>("video_gen_runs");
        using var identity = TaskExecutionContext.Enter(new(proof.PermitId, proof.RunId, proof, target));
        BsonValue value = field == "Scenes.1.Cost" ? new BsonDouble(1.0)
            : field == "QueueEnteredAt" ? new BsonDateTime(DateTime.UtcNow) : new BsonString("forbidden");
        UpdateDefinition<VideoGenRun> update = new BsonDocument("$set", new BsonDocument(field, value));
        var denied = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => guarded.UpdateOneAsync(x => x.Id == "synthetic-parent",
            update, cancellationToken: CancellationToken.None));
        Assert.Equal("TASK_VIDEO_RECEIPT_WRITE_DENIED", denied.Code);
        rows.Verify(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<VideoGenRun>>(), It.IsAny<UpdateDefinition<VideoGenRun>>(),
            It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>()), Times.Never);
    }

}
