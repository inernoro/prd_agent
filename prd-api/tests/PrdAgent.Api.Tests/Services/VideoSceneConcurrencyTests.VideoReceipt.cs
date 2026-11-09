using System.Reflection;
using System.Runtime.CompilerServices;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;
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
    [InlineData(0.34)]
    [InlineData(null)]
    public async Task DirectRecordedCostMock_OmittedReceiptCostDoesNotEraseRecordedCharge(double? recordedCost)
    {
        BsonClassMapRegistration.Register();
        var run = new VideoGenRun { Id = "synthetic-direct", OwnerAdminId = "synthetic-owner", AppKey = "video-agent",
            Mode = VideoGenMode.Direct, TaskPermitId = "synthetic-permit", Status = VideoGenRunStatus.Cancelled,
            CancelRequested = true, EndedAt = DateTime.UnixEpoch, DirectVideoJobId = "recorded-job",
            DirectVideoModel = "recorded-model", DirectVideoOfferingId = "recorded-offering", DirectVideoCost = recordedCost };
        var target = new VideoReceiptTarget(run.OwnerAdminId, AppCallerRegistry.VideoAgent.VideoGen.Generate,
            run.DirectVideoJobId, run.DirectVideoModel, run.DirectVideoOfferingId);
        var proof = new TaskExecutionLeaseProof(run.TaskPermitId, run.Id, "synthetic-token", 7);
        var coordinator = new Mock<ITaskExecutionCoordinator>(MockBehavior.Strict);
        coordinator.Setup(x => x.AcquireVideoReceiptAsync(run.TaskPermitId, run.Id, CancellationToken.None))
            .ReturnsAsync(() => new TaskExecutionLease(coordinator.Object, proof, borrowed: true, videoReceipt: target));
        coordinator.Setup(x => x.ValidateVideoReceiptAsync(proof, target, false, CancellationToken.None)).ReturnsAsync(true);
        coordinator.Setup(x => x.ReleaseVideoReceiptAsync(proof, target, CancellationToken.None)).ReturnsAsync(true);
        coordinator.Setup(x => x.RevokeVideoReceiptAsync(run.TaskPermitId, run.Id, CancellationToken.None)).Returns(Task.CompletedTask);
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
        BsonDocument? written = null;
        rows.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<VideoGenRun>>(), It.IsAny<UpdateDefinition<VideoGenRun>>(),
                It.IsAny<UpdateOptions>(), CancellationToken.None))
            .Returns((FilterDefinition<VideoGenRun> _, UpdateDefinition<VideoGenRun> patch, UpdateOptions _, CancellationToken _) =>
            {
                written = patch.Render(new RenderArgs<VideoGenRun>(BsonSerializer.LookupSerializer<VideoGenRun>(), BsonSerializer.SerializerRegistry)).AsBsonDocument;
                if (written["$set"].AsBsonDocument.TryGetValue("DirectVideoCost", out var value))
                    run.DirectVideoCost = value.IsBsonNull ? null : value.ToDouble();
                return Task.FromResult<UpdateResult>(new UpdateResult.Acknowledged(1, 1, null));
            });
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<VideoGenRun>("video_gen_runs", null)).Returns(rows.Object);
        var context = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(context, TaskLifecycleMongoDatabase.Wrap(database.Object, () => coordinator.Object));
        var client = new Mock<IOpenRouterVideoClient>(MockBehavior.Strict);
        client.Setup(x => x.GetStatusForOfferingAsync(target.AppCallerCode, target.JobId, target.Model, target.OfferingId, CancellationToken.None))
            .ReturnsAsync(new OpenRouterVideoStatus { Status = "completed", Cost = null, VideoUrl = "https://synthetic.invalid/never-download" });
        using var services = new ServiceCollection().AddSingleton(client.Object)
            .AddSingleton<ILLMRequestContextAccessor, LLMRequestContextAccessor>().BuildServiceProvider();
        var assets = new Mock<IAssetStorage>(MockBehavior.Strict); var events = new Mock<IRunEventStore>(MockBehavior.Strict);
        using var worker = new VideoGenRunWorker(context, services.GetRequiredService<IServiceScopeFactory>(), events.Object,
            assets.Object, NullLogger<VideoGenRunWorker>.Instance, coordinator.Object);
        await (Task)typeof(VideoGenRunWorker).GetMethod("ProcessDirectVideoGenAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(worker, [run])!;
        Assert.Equal(recordedCost, run.DirectVideoCost);
        Assert.NotNull(written); Assert.True(written!["$set"].AsBsonDocument.Contains("DirectVideoReconciledAt"));
        Assert.Equal(VideoGenRunStatus.Cancelled, run.Status); Assert.Equal(DateTime.UnixEpoch, run.EndedAt);
        client.Verify(x => x.GetStatusForOfferingAsync(target.AppCallerCode, target.JobId, target.Model, target.OfferingId, CancellationToken.None), Times.Once);
        client.VerifyNoOtherCalls(); assets.VerifyNoOtherCalls(); events.VerifyNoOtherCalls();
        coordinator.Verify(x => x.RegisterAsync(It.IsAny<GatewayTaskPermitRecord>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()), Times.Never);
    }

}
