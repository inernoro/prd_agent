using System.Reflection;
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
}
