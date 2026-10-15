using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>真实独立 Mongo 并发和代次行为，零供应商请求；不连接应用数据库。</summary>
[Trait("Category", "Integration")]
public sealed class TaskExecutionCoordinatorIntegrationTests : IAsyncLifetime
{
    private string _database = "";
    private string _connection = "";
    private LlmGatewayDataContext _data = null!;
    private TaskExecutionCoordinator Coordinator => new(_data);
    private IMongoCollection<GatewayTaskPermitRecord> Permits =>
        _data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);

    public Task InitializeAsync()
    {
        _connection = Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION") ?? "";
        var url = new MongoUrl(_connection);
        Assert.Single(url.Servers); Assert.Equal("127.0.0.1", url.Server.Host); Assert.Equal(27389, url.Server.Port); Assert.Null(url.Username);
        _database = "phase2_execution_" + Guid.NewGuid().ToString("N");
        _data = new(_connection, _database);
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        if (_database.StartsWith("phase2_execution_", StringComparison.Ordinal))
            await new MongoClient(_connection).DropDatabaseAsync(_database);
    }

    [DesignScopeMongoFact]
    public async Task DuplicateBusinessIntent_AcrossThirtyInstances_HasOnePermitAndOneAcceptedOwner()
    {
        var key = Guid.NewGuid().ToString("N");
        var attempts = await Task.WhenAll(Enumerable.Range(0, 30).Select(i =>
        {
            var permit = Permit(key); permit.SourceDeployment = "instance-" + i;
            return new TaskExecutionCoordinator(_data).RegisterAsync(permit, true, default);
        }));
        try
        {
            Assert.Single(attempts, x => !x.Replayed);
            Assert.Equal(29, attempts.Count(x => x.Replayed));
            Assert.Single(attempts, x => x.Lease is not null);
            var stored = Assert.Single(await Permits.Find(FilterDefinition<GatewayTaskPermitRecord>.Empty).ToListAsync());
            Assert.Single(stored.Executions);
            Assert.Equal(0, stored.CallCount);
            Assert.True(await Coordinator.ValidateAsync(attempts.Single(x => !x.Replayed).Lease!.Proof, false, default));
        }
        finally { foreach (var item in attempts) if (item.Lease is not null) await item.Lease.DisposeAsync(); }
    }

    [DesignScopeMongoFact]
    public async Task SameIntentWithDifferentParameters_IsConflict_WhileNewUserIntentIsIndependent()
    {
        var key = Guid.NewGuid().ToString("N");
        var first = await Coordinator.RegisterAsync(Permit(key), true, default);
        await using var firstLease = first.Lease!;
        var other = Permit(key); other.RequestFingerprint = TaskExecutionCoordinator.Fingerprint("different parameters");
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Coordinator.RegisterAsync(other, true, default));
        Assert.Equal("TASK_IDEMPOTENCY_CONFLICT", error.Code);
        var newAction = await Coordinator.RegisterAsync(Permit(Guid.NewGuid().ToString("N")), true, default);
        await using var newLease = newAction.Lease!;
        Assert.False(newAction.Replayed);
        Assert.NotEqual(first.Permit.Id, newAction.Permit.Id);
        Assert.Equal(2, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    [DesignScopeMongoFact]
    public async Task TenantAndActor_ArePartOfBusinessIdentity_WithoutMachineOrDeployment()
    {
        var first = Permit("same-key");
        var actor = Permit("same-key", actor: "other-user");
        var tenant = Permit("same-key", tenant: "other-tenant");
        Assert.NotEqual(first.Id, actor.Id); Assert.NotEqual(first.Id, tenant.Id);
        var firstResult = await Coordinator.RegisterAsync(first, true, default);
        await using var l1 = firstResult.Lease!;
        var actorResult = await Coordinator.RegisterAsync(actor, true, default);
        await using var l2 = actorResult.Lease!;
        var tenantResult = await Coordinator.RegisterAsync(tenant, true, default);
        await using var l3 = tenantResult.Lease!;
        Assert.All(new[] { firstResult, actorResult, tenantResult }, x => Assert.False(x.Replayed));
    }

    [DesignScopeMongoFact]
    public async Task DuplicateQueueDelivery_HasOneLease_AndCompletedTaskCannotBeReexecuted()
    {
        var admitted = await Coordinator.RegisterAsync(Permit("queue"), false, default);
        Assert.False(admitted.Replayed);
        var results = await Task.WhenAll(Enumerable.Range(0, 30).Select(async _ =>
        {
            try { return await new TaskExecutionCoordinator(_data).AcquireAsync(admitted.Permit.Id, "run-1", default); }
            catch (TaskExecutionAdmissionException e) when (e.Code == "TASK_EXECUTION_UNAVAILABLE") { return null; }
        }));
        var winner = Assert.Single(results.Where(x => x is not null))!;
        Assert.Equal(1, winner.Proof.Fence);
        Assert.True(await Coordinator.CompleteAsync(winner.Proof, default));
        await winner.DisposeAsync();
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Coordinator.AcquireAsync(admitted.Permit.Id, "run-1", default));
        Assert.Equal("TASK_EXECUTION_UNAVAILABLE", error.Code);
        var record = await ReadAsync(admitted.Permit.Id);
        Assert.Single(record.Executions); Assert.Equal(["run-1"], record.BoundRunIds);
    }

    [DesignScopeMongoFact]
    public async Task NormalRenewal_UsesDatabaseTime_AndMaintainsCurrentOwner()
    {
        var admitted = await Coordinator.RegisterAsync(Permit("renew"), true, default);
        await using var lease = admitted.Lease!;
        var before = (await ReadAsync(admitted.Permit.Id)).Executions.Single().LeaseUntil;
        Assert.True(await Coordinator.RenewAsync(lease.Proof, default));
        var after = (await ReadAsync(admitted.Permit.Id)).Executions.Single();
        Assert.True(after.LeaseUntil >= before);
        Assert.Equal(lease.Proof.Fence, after.Fence);
        Assert.Equal(TaskExecutionCoordinator.OwnerHash(lease.Proof.OwnerToken), after.OwnerHash);
        Assert.True(after.LeaseUntil > DateTime.UtcNow.AddSeconds(35));
    }

    [DesignScopeMongoFact]
    public async Task ExpiredUnsentExecution_CanBeTakenOver_ButOldHeartbeatSendAndCommitCannotRevive()
    {
        var admitted = await Coordinator.RegisterAsync(Permit("takeover"), false, default);
        await using var old = await Coordinator.AcquireAsync(admitted.Permit.Id, "run-1", default);
        await ExpireAsync(admitted.Permit.Id, "run-1");
        await using var next = await Coordinator.AcquireAsync(admitted.Permit.Id, "run-1", default);
        Assert.True(next.Proof.Fence > old.Proof.Fence);
        Assert.False(await Coordinator.RenewAsync(old.Proof, default));
        Assert.False(await Coordinator.ValidateAsync(old.Proof, true, default));
        Assert.False(await Coordinator.CompleteAsync(old.Proof, default));
        Assert.True(await Coordinator.ValidateAsync(next.Proof, false, default));
    }

    [DesignScopeMongoFact]
    public async Task ExpiredExecutionWithExternalDispatch_IsHeldForOutcomeReview_InsteadOfAutomaticPaidRetry()
    {
        var admitted = await Coordinator.RegisterAsync(Permit("unknown"), false, default);
        await using var lease = await Coordinator.AcquireAsync(admitted.Permit.Id, "run-1", default);
        Assert.True(await Coordinator.ValidateAsync(lease.Proof, true, default));
        await ExpireAsync(admitted.Permit.Id, "run-1");
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Coordinator.AcquireAsync(admitted.Permit.Id, "run-1", default));
        Assert.Equal("TASK_EXECUTION_OUTCOME_UNKNOWN", error.Code);
        Assert.False(await Coordinator.RenewAsync(lease.Proof, default));
        Assert.Equal(1, (await ReadAsync(admitted.Permit.Id)).Executions.Single().DispatchCount);
    }

    [DesignScopeMongoFact]
    public async Task CancelOneExecution_RevokesOnlyItsScope_AndCancellationBeforeClaimCannotBeOverwritten()
    {
        var admitted = await Coordinator.RegisterAsync(Permit("cancel-child"), false, default);
        await using var first = await Coordinator.AcquireAsync(admitted.Permit.Id, "run-1", default);
        await using var sibling = await Coordinator.AcquireAsync(admitted.Permit.Id, "run-2", default);
        await Coordinator.RevokeAsync(admitted.Permit.Id, "run-1", default);
        Assert.False(await Coordinator.ValidateAsync(first.Proof, true, default));
        Assert.False(await Coordinator.RenewAsync(first.Proof, default));
        Assert.False(await Coordinator.CompleteAsync(first.Proof, default));
        Assert.True(await Coordinator.ValidateAsync(sibling.Proof, false, default));
        Assert.Null((await ReadAsync(admitted.Permit.Id)).RevokedAt);

        var pending = await Coordinator.RegisterAsync(Permit("cancel-pending"), false, default);
        await Coordinator.RevokeAsync(pending.Permit.Id, "queued-run", default);
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Coordinator.AcquireAsync(pending.Permit.Id, "queued-run", default));
        Assert.Equal("TASK_EXECUTION_UNAVAILABLE", error.Code);
    }

    [DesignScopeMongoFact]
    public async Task ParentCancellation_RejectsEveryLaterDispatch_RenewalAndCompletion_NewExplicitIntentStillWorks()
    {
        var admitted = await Coordinator.RegisterAsync(Permit("cancel-parent"), true, default);
        await using var lease = admitted.Lease!;
        await Coordinator.RevokeAsync(admitted.Permit.Id, null, default);
        var sends = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => Coordinator.ValidateAsync(lease.Proof, true, default)));
        Assert.All(sends, value => Assert.False(value));
        Assert.False(await Coordinator.RenewAsync(lease.Proof, default));
        Assert.False(await Coordinator.CompleteAsync(lease.Proof, default));
        var retry = await Coordinator.RegisterAsync(Permit("new-explicit-operation"), true, default);
        await using var retryLease = retry.Lease!;
        Assert.True(await Coordinator.ValidateAsync(retryLease.Proof, false, default));
    }

    [DesignScopeMongoFact]
    public async Task ActorDisableAndEnable_NeverRevivesOldTaskPermits()
    {
        var admitted = await Coordinator.RegisterAsync(Permit("actor"), true, default);
        await using var lease = admitted.Lease!;
        await Coordinator.ChangeActorAuthorizationAsync("tenant", "user", false, default);
        Assert.False(await Coordinator.ValidateAsync(lease.Proof, true, default));
        var disabled = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Coordinator.RegisterAsync(Permit("disabled-new"), true, default));
        Assert.Equal("TASK_TRIGGER_REVOKED", disabled.Code);
        await Coordinator.ChangeActorAuthorizationAsync("tenant", "user", true, default);
        Assert.False(await Coordinator.ValidateAsync(lease.Proof, true, default));
        var next = await Coordinator.RegisterAsync(Permit("enabled-new"), true, default);
        await using var nextLease = next.Lease!;
        Assert.Equal(2, next.Permit.ActorAuthorizationVersion);
        Assert.True(await Coordinator.ValidateAsync(nextLease.Proof, true, default));
    }

    [DesignScopeMongoFact]
    public async Task TriggerCredentialRevocation_StopsCurrentTaskAndFurtherIssuance_WithoutAffectingOtherCredential()
    {
        var admitted = await Coordinator.RegisterAsync(Permit("credential"), true, default);
        await using var lease = admitted.Lease!;
        await Coordinator.RevokeCredentialAsync("tenant", "agent-api-key:key-1", default);
        Assert.False(await Coordinator.ValidateAsync(lease.Proof, true, default));
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Coordinator.RegisterAsync(Permit("new"), true, default));
        Assert.Equal("TASK_TRIGGER_REVOKED", error.Code);
        var other = Permit("other-key"); other.TriggerCredentialId = "agent-api-key:key-2";
        var next = await Coordinator.RegisterAsync(other, true, default);
        await using var nextLease = next.Lease!;
        Assert.True(await Coordinator.ValidateAsync(nextLease.Proof, true, default));
    }

    [DesignScopeMongoFact]
    public async Task LeaseObjectsRemainWithinParentBudget_AndNoPermitOrLegacyRecordCanAcquire()
    {
        var admitted = await Coordinator.RegisterAsync(Permit("bounded"), false, default);
        await using var first = await Coordinator.AcquireAsync(admitted.Permit.Id, "run-1", default);
        await using var second = await Coordinator.AcquireAsync(admitted.Permit.Id, "run-2", default);
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Coordinator.AcquireAsync(admitted.Permit.Id, "run-3", default));
        Assert.Equal(2, (await ReadAsync(admitted.Permit.Id)).Executions.Count);
        var legacy = Permit("legacy"); legacy.ExecutionContractVersion = 0;
        await Permits.InsertOneAsync(legacy);
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Coordinator.AcquireAsync(legacy.Id, "run", default));
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Coordinator.AcquireAsync(Guid.NewGuid().ToString("N"), "run", default));
    }

    [DesignScopeMongoFact]
    public async Task DelayedHttpResponse_FromStaleOwner_CannotReplaceCurrentAdmissionResult()
    {
        var admitted = await Coordinator.RegisterAsync(Permit("stale-response"), false, default);
        await using var old = await Coordinator.AcquireAsync(admitted.Permit.Id, "run", default);
        await ExpireAsync(admitted.Permit.Id, "run");
        await using var current = await Coordinator.AcquireAsync(admitted.Permit.Id, "run", default);
        using (TaskExecutionContext.Enter(current.Identity))
            await Coordinator.SaveAcceptedResponseAsync(admitted.Permit.Id, 202, "application/json", "current result", default);
        using (TaskExecutionContext.Enter(old.Identity))
            await Coordinator.SaveAcceptedResponseAsync(admitted.Permit.Id, 200, "application/json", "stale result", default);
        var stored = await ReadAsync(admitted.Permit.Id);
        Assert.Equal(202, stored.AcceptedResponseStatus); Assert.Equal("current result", stored.AcceptedResponseBody);
    }

    [DesignScopeMongoFact]
    public async Task LostStorage_FailsClosedWithRecoverableMessage_AndDoesNotReportRawDatabaseError()
    {
        var unavailable = new TaskExecutionCoordinator(new LlmGatewayDataContext(
            "mongodb://127.0.0.1:27388/?serverSelectionTimeoutMS=200&connectTimeoutMS=200", "phase2_unavailable"));
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => unavailable.RegisterAsync(Permit("offline"), true, default));
        Assert.Equal(503, error.StatusCode);
        Assert.DoesNotContain("Mongo", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [DesignScopeMongoFact]
    public async Task NewBusiness_OmittingLocalRevoke_IsCancelledByTaskStorage()
    {
        var permit = Permit(Guid.NewGuid().ToString("N"));
        await Coordinator.RegisterAsync(permit, false, default);
        await using var first = await Coordinator.AcquireAsync(permit.Id, "future-one", default);
        await using var sibling = await Coordinator.AcquireAsync(permit.Id, "future-two", default);
        var tasks = _data.Database.GetCollection<FutureBusinessRun>("future_tasks");
        await tasks.InsertOneAsync(new() { Id = "future-one", TaskPermitId = permit.Id });
        // 业务只改自身状态，刻意没有调用 RevokeAsync。
        await tasks.UpdateOneAsync(x => x.Id == "future-one", Builders<FutureBusinessRun>.Update.Set(x => x.CancelRequested, true));
        Assert.False(await Coordinator.ValidateAsync(first.Proof, true, default));
        Assert.True(await Coordinator.ValidateAsync(sibling.Proof, false, default));
        Assert.True((await tasks.Find(x => x.Id == "future-one").SingleAsync()).CancelRequested);
    }

    [DesignScopeMongoFact]
    public async Task DeleteAndStatusCancellation_AutomaticallyRevokeEvenThroughRawDatabaseCollection()
    {
        var permit = Permit(Guid.NewGuid().ToString("N"));
        await Coordinator.RegisterAsync(permit, false, default);
        await using var first = await Coordinator.AcquireAsync(permit.Id, "delete-one", default);
        await using var second = await Coordinator.AcquireAsync(permit.Id, "cancel-two", default);
        var tasks = _data.Database.GetCollection<FutureBusinessRun>("future_tasks");
        await tasks.InsertManyAsync(new[] { new FutureBusinessRun { Id = "delete-one", TaskPermitId = permit.Id }, new FutureBusinessRun { Id = "cancel-two", TaskPermitId = permit.Id } });
        await tasks.DeleteOneAsync(x => x.Id == "delete-one");
        await tasks.UpdateOneAsync(x => x.Id == "cancel-two", Builders<FutureBusinessRun>.Update.Set(x => x.Status, "cancelled"));
        Assert.False(await Coordinator.ValidateAsync(first.Proof, true, default));
        Assert.False(await Coordinator.ValidateAsync(second.Proof, true, default));
    }

    [DesignScopeMongoFact]
    public async Task CancelledExecutor_CannotPublishLateTaskState_ButNormalUserCrudStillWorks()
    {
        var permit = Permit(Guid.NewGuid().ToString("N"));
        await Coordinator.RegisterAsync(permit, false, default);
        await using var lease = await Coordinator.AcquireAsync(permit.Id, "late", default);
        var tasks = _data.Database.GetCollection<FutureBusinessRun>("future_tasks");
        await tasks.InsertOneAsync(new() { Id = "late", TaskPermitId = permit.Id });
        await Coordinator.RevokeAsync(permit.Id, "late", default);
        using (TaskExecutionContext.Enter(lease.Identity))
            await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => tasks.UpdateOneAsync(x => x.Id == "late", Builders<FutureBusinessRun>.Update.Set(x => x.Status, "done")));
        Assert.Equal("queued", (await tasks.Find(x => x.Id == "late").SingleAsync()).Status);
        await _data.Database.GetCollection<BsonDocument>("ordinary_crud").InsertOneAsync(new BsonDocument("text", "normal"));
        Assert.Equal(1, await _data.Database.GetCollection<BsonDocument>("ordinary_crud").CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty));
    }

    [DesignScopeMongoFact]
    public async Task DisablingAndReenablingAccount_ThroughOrdinaryStorage_DoesNotReviveOldTasks()
    {
        var permit = Permit(Guid.NewGuid().ToString("N"), tenant: GatewayTenantDefaults.InternalTenantId);
        await _data.Context.Users.InsertOneAsync(new User { UserId = permit.ActorUserId, Username = "test-owner" });
        await Coordinator.RegisterAsync(permit, false, default);
        await using var lease = await Coordinator.AcquireAsync(permit.Id, "account-task", default);
        await _data.Context.Users.UpdateOneAsync(x => x.UserId == permit.ActorUserId, Builders<User>.Update.Set(x => x.Status, UserStatus.Disabled));
        Assert.False(await Coordinator.ValidateAsync(lease.Proof, true, default));
        await _data.Context.Users.UpdateOneAsync(x => x.UserId == permit.ActorUserId, Builders<User>.Update.Set(x => x.Status, UserStatus.Active));
        Assert.False(await Coordinator.ValidateAsync(lease.Proof, true, default));
        var fresh = Permit(Guid.NewGuid().ToString("N"), tenant: GatewayTenantDefaults.InternalTenantId);
        await Coordinator.RegisterAsync(fresh, false, default);
        await using var valid = await Coordinator.AcquireAsync(fresh.Id, "new-task", default);
        Assert.True(await Coordinator.ValidateAsync(valid.Proof, false, default));
    }

    [DesignScopeMongoFact]
    public async Task BackgroundChild_DoesNotBorrowInlineLease_AndSurvivesNormalHttpCompletion()
    {
        var admitted = await Coordinator.RegisterAsync(Permit(Guid.NewGuid().ToString("N")), true, default);
        Assert.NotNull(admitted.Lease);
        await using var root = admitted.Lease!;
        TaskExecutionLease child;
        using (TaskExecutionContext.Enter(root.Identity with { RunId = "background-child" }))
            child = await Coordinator.AcquireAsync(root.Proof.PermitId, "background-child", default);
        await using var ownedChild = child;
        Assert.Equal("background-child", child.Proof.RunId);
        await root.DisposeAsync();
        Assert.True(await Coordinator.ValidateAsync(child.Proof, false, default));
    }

    [DesignScopeMongoFact]
    public async Task OrdinaryAccountProfileReplacement_DoesNotRevokeActiveTask()
    {
        var permit = Permit(Guid.NewGuid().ToString("N"), tenant: GatewayTenantDefaults.InternalTenantId);
        var user = new User { UserId = permit.ActorUserId, Username = "profile-test" };
        await _data.Context.Users.InsertOneAsync(user);
        await Coordinator.RegisterAsync(permit, false, default);
        await using var lease = await Coordinator.AcquireAsync(permit.Id, "active-profile", default);
        user.DisplayName = "新的显示名";
        await _data.Context.Users.ReplaceOneAsync(x => x.UserId == user.UserId, user);
        Assert.True(await Coordinator.ValidateAsync(lease.Proof, false, default));
    }

    [DesignScopeMongoFact]
    public async Task EncryptedSdkToolContinuation_IsBoundToLiveRunOwnerAndCancellation()
    {
        var permit = Permit(Guid.NewGuid().ToString("N"));
        await Coordinator.RegisterAsync(permit, false, default);
        await using var lease = await Coordinator.AcquireAsync(permit.Id, "sdk-parent", default);
        var tokens = new TaskContinuationTokens(new Microsoft.AspNetCore.DataProtection.EphemeralDataProtectionProvider(), Coordinator);
        var token = tokens.Issue(lease.Identity, "callback-transport-run", "subject", DateTime.UtcNow.AddMinutes(10));
        Assert.DoesNotContain(lease.Proof.OwnerToken, token);
        Assert.NotNull(await tokens.ValidateAsync(token, "callback-transport-run", "subject"));
        Assert.Null(await tokens.ValidateAsync(token, "another-run", "subject"));
        Assert.Null(await tokens.ValidateAsync(token, "callback-transport-run", "another-owner"));
        await Coordinator.RevokeAsync(permit.Id, "sdk-parent", default);
        Assert.Null(await tokens.ValidateAsync(token, "callback-transport-run", "subject"));
        Assert.False(await tokens.ValidateTokenAsync(token));
    }

    [DesignScopeMongoFact]
    public async Task ExistingEventPipeline_PreservesComputedProgress_AndRevokesLiteralCancellation()
    {
        var permit = Permit(Guid.NewGuid().ToString("N")); await Coordinator.RegisterAsync(permit, false, default);
        await using var lease = await Coordinator.AcquireAsync(permit.Id, "pipeline", default);
        var tasks = _data.Database.GetCollection<FutureBusinessRun>("future_tasks");
        await tasks.InsertOneAsync(new() { Id = "pipeline", TaskPermitId = permit.Id });
        await tasks.UpdateOneAsync(x => x.Id == "pipeline", Builders<FutureBusinessRun>.Update.Pipeline(new BsonDocument[]
            { new("$set", new BsonDocument { ["CancelRequested"] = true, ["Status"] = "cancelled", ["Version"] = new BsonDocument("$add", new BsonArray { new BsonDocument("$ifNull", new BsonArray { "$Version", 0 }), 1 }) }) }));
        Assert.False(await Coordinator.ValidateAsync(lease.Proof, true, default));
        var raw = await _data.Database.GetCollection<BsonDocument>("future_tasks").Find(new BsonDocument("_id", "pipeline")).SingleAsync();
        Assert.Equal(1, raw["Version"].AsInt32);
    }

    [DesignScopeMongoFact]
    public async Task ExplicitEnable_CanRepairConservativeRevocationAfterAnInterruptedBusinessWrite()
    {
        var tenant = GatewayTenantDefaults.InternalTenantId;
        var permit = Permit(Guid.NewGuid().ToString("N"), tenant: tenant);
        await _data.Context.Users.InsertOneAsync(new User { UserId = permit.ActorUserId, Username = "repair-test" });
        // 模拟先撤销成功、业务状态写失败；不能由普通资料更新偷偷复活旧授权。
        await Coordinator.ChangeActorAuthorizationAsync(tenant, permit.ActorUserId, false, default);
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Coordinator.RegisterAsync(permit, false, default));
        await _data.Context.Users.UpdateOneAsync(x => x.UserId == permit.ActorUserId, Builders<User>.Update.Set(x => x.Status, UserStatus.Active));
        await Coordinator.RegisterAsync(permit, false, default);
        await using var lease = await Coordinator.AcquireAsync(permit.Id, "repaired", default);
        Assert.True(await Coordinator.ValidateAsync(lease.Proof, false, default));
    }

    [DesignScopeMongoFact]
    public async Task CancelReadBeforeExplicitRerun_CannotCancelOrDeleteTheNewBusinessGeneration()
    {
        var oldPermit = Permit(Guid.NewGuid().ToString("N")); var nextPermit = Permit(Guid.NewGuid().ToString("N"));
        await Coordinator.RegisterAsync(oldPermit, false, default); await Coordinator.RegisterAsync(nextPermit, false, default);
        await using var oldLease = await Coordinator.AcquireAsync(oldPermit.Id, "same-row", default);
        await using var nextLease = await Coordinator.AcquireAsync(nextPermit.Id, "same-row", default);
        var raw = new MongoClient(_connection).GetDatabase(_database);
        var rawTasks = raw.GetCollection<FutureBusinessRun>("generation_race");
        await rawTasks.InsertOneAsync(new() { Id = "same-row", TaskPermitId = oldPermit.Id });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var coordinator = new Moq.Mock<ITaskExecutionCoordinator>(Moq.MockBehavior.Strict);
        coordinator.Setup(x => x.RevokeAsync(oldPermit.Id, "same-row", Moq.It.IsAny<CancellationToken>())).Returns(async () =>
        { await Coordinator.RevokeAsync(oldPermit.Id, "same-row", default); entered.TrySetResult(); await release.Task; });
        var tasks = TaskLifecycleMongoDatabase.Wrap(raw, () => coordinator.Object).GetCollection<FutureBusinessRun>("generation_race");
        var cancel = tasks.UpdateOneAsync(x => x.Id == "same-row", Builders<FutureBusinessRun>.Update.Set(x => x.CancelRequested, true));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            await rawTasks.UpdateOneAsync(x => x.Id == "same-row", Builders<FutureBusinessRun>.Update.Set(x => x.TaskPermitId, nextPermit.Id));
        }
        finally { release.TrySetResult(); }
        Assert.Equal(0, (await cancel).ModifiedCount);
        var current = await rawTasks.Find(x => x.Id == "same-row").SingleAsync();
        Assert.Equal(nextPermit.Id, current.TaskPermitId); Assert.False(current.CancelRequested);
        Assert.False(await Coordinator.ValidateAsync(oldLease.Proof, true, default));
        Assert.True(await Coordinator.ValidateAsync(nextLease.Proof, false, default));
    }

    [DesignScopeMongoFact]
    public async Task LateFailureOutsideWorkerScope_CannotOverwriteCancellation_ButExplicitNewIntentCanRun()
    {
        var oldPermit = Permit(Guid.NewGuid().ToString("N")); await Coordinator.RegisterAsync(oldPermit, false, default);
        var tasks = _data.Database.GetCollection<FutureBusinessRun>("cancel_monotonic");
        await tasks.InsertOneAsync(new() { Id = "cancelled-row", TaskPermitId = oldPermit.Id });
        await tasks.UpdateOneAsync(x => x.Id == "cancelled-row", Builders<FutureBusinessRun>.Update.Set(x => x.Status, "cancelled"));
        // 特意模拟作用域已经退出后旧 Worker 的通用异常兜底。
        var late = await tasks.UpdateOneAsync(x => x.Id == "cancelled-row", Builders<FutureBusinessRun>.Update.Set(x => x.Status, "failed"));
        Assert.Equal(0, late.ModifiedCount);
        Assert.Equal("cancelled", (await tasks.Find(x => x.Id == "cancelled-row").SingleAsync()).Status);
        var nextPermit = Permit(Guid.NewGuid().ToString("N"));
        var admitted = await Coordinator.RegisterAsync(nextPermit, true, default);
        await using var root = admitted.Lease!;
        using (TaskExecutionContext.Enter(root.Identity))
        {
            var retry = await tasks.UpdateOneAsync(x => x.Id == "cancelled-row", Builders<FutureBusinessRun>.Update
                .Set(x => x.TaskPermitId, nextPermit.Id).Set(x => x.Status, "queued").Set(x => x.CancelRequested, false));
            Assert.Equal(1, retry.ModifiedCount);
        }
        Assert.Equal(nextPermit.Id, (await tasks.Find(x => x.Id == "cancelled-row").SingleAsync()).TaskPermitId);
    }

    public sealed class FutureBusinessRun : ITaskAuthorizedRun
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");
        [System.Text.Json.Serialization.JsonIgnore]
        public string? TaskPermitId { get; set; }
        public string Status { get; set; } = "queued";
        public bool CancelRequested { get; set; }
    }

    private GatewayTaskPermitRecord Permit(string key, string actor = "user", string tenant = "tenant") => new()
    {
        Id = TaskExecutionCoordinator.BusinessId(tenant, actor, "registered-operation", key),
        ExecutionContractVersion = TaskExecutionCoordinator.ContractVersion,
        BusinessKeyHash = TaskExecutionCoordinator.Fingerprint(key),
        RequestFingerprint = TaskExecutionCoordinator.Fingerprint("same-validated-parameters"),
        TenantId = tenant, ActorUserId = actor, SubjectUserIds = [actor], TriggerCredentialId = "agent-api-key:key-1",
        Origin = TaskExecutionOrigins.Agent, SourceDeployment = "deployment", SourceTask = "registered-operation",
        AllowedAppCallerCodes = ["future-business.chat::chat"], MaxRuns = 2, MaxCalls = 16,
        CreatedAt = DateTime.UtcNow, ExpiresAt = DateTime.UtcNow.AddHours(24)
    };
    private Task<GatewayTaskPermitRecord> ReadAsync(string id) => Permits.Find(x => x.Id == id).SingleAsync();
    private Task ExpireAsync(string id, string runId)
        => Permits.UpdateOneAsync(new BsonDocument { ["_id"] = id, ["Executions.RunId"] = runId },
            Builders<GatewayTaskPermitRecord>.Update.Set("Executions.$.LeaseUntil", DateTime.UnixEpoch));
}
