using MongoDB.Bson;
using MongoDB.Driver;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class DesignArtifactRunRecoveryTests
{
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RejectedWorkspaceResultCleanup_ShouldRetryFromDurableRunState()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var firstAttempt = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-rejected-workspace-result", firstAttempt);
        run.Status = RunStatuses.Error;
        run.WorkspaceResultSha256 = new string('a', 64);
        run.WorkspaceRejectedResultAssetKey = "web-hosting/meta/abcdefghijklmnopqrstuvwxyz.json";
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var attempts = 0;
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.DeleteByKeyAsync(run.WorkspaceRejectedResultAssetKey, CancellationToken.None))
            .Returns(() =>
            {
                if (Interlocked.Increment(ref attempts) == 1)
                    throw new IOException("workspace cleanup unavailable");
                return Task.CompletedTask;
            });

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            new InMemoryRunEventStore(),
            firstAttempt,
            CancellationToken.None,
            workspaceStorage: storage.Object);
        var pending = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Equal(run.WorkspaceRejectedResultAssetKey, pending.WorkspaceRejectedResultAssetKey);
        Assert.Equal(firstAttempt, pending.WorkspaceRejectedResultCleanupAttemptedAt);
        Assert.Contains("workspace cleanup unavailable", pending.WorkspaceRejectedResultCleanupError);
        Assert.Equal(run.WorkspaceResultSha256, pending.WorkspaceResultSha256);

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            new InMemoryRunEventStore(),
            firstAttempt.Add(HostedSiteEditRunWorker.RecoveryInterval),
            CancellationToken.None,
            workspaceStorage: storage.Object);
        var cleaned = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Null(cleaned.WorkspaceRejectedResultAssetKey);
        Assert.Null(cleaned.WorkspaceRejectedResultCleanupAttemptedAt);
        Assert.Null(cleaned.WorkspaceRejectedResultCleanupError);
        Assert.Null(cleaned.WorkspaceResultSha256);
        Assert.Equal(2, attempts);
        storage.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task FreshHeartbeat_ShouldFenceOtherInstancesAndSurviveOriginalExpiry()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-fresh", now);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);

        var claimed = await HostedSiteEditRunWorker.TryClaimAsync(
            fixture.Db, run.Id, "worker-a", now, TimeSpan.FromMinutes(2), CancellationToken.None);
        Assert.NotNull(claimed);
        var stolen = await HostedSiteEditRunWorker.TryClaimAsync(
            fixture.Db, run.Id, "worker-b", now.AddSeconds(1), TimeSpan.FromMinutes(2), CancellationToken.None);
        Assert.Null(stolen);

        Assert.True(await HostedSiteEditRunWorker.RenewLeaseAsync(
            fixture.Db,
            run.Id,
            "worker-a",
            now.AddMinutes(1),
            TimeSpan.FromMinutes(2),
            CancellationToken.None));

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            new InMemoryRunEventStore(),
            now.AddMinutes(2).AddSeconds(1),
            CancellationToken.None);

        var persisted = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Equal(RunStatuses.Running, persisted.Status);
        Assert.Equal("worker-a", persisted.LeaseOwnerId);
        Assert.Equal(now.AddMinutes(1), persisted.HeartbeatAt);
    }

    [Theory]
    [InlineData(RunStatuses.Running)]
    [InlineData(RunStatuses.Committing)]
    [Trait("Category", TestCategories.Integration)]
    public async Task ExpiredActiveRun_ShouldBecomeVisibleTerminalErrorWithoutRedisMetadata(string activeStatus)
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-expired", now.AddMinutes(-10));
        run.Status = activeStatus;
        run.LeaseOwnerId = "dead-worker";
        run.LeaseExpiresAt = now.AddSeconds(-1);
        run.HeartbeatAt = now.AddMinutes(-3);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var events = new InMemoryRunEventStore();

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            events,
            now,
            CancellationToken.None);

        var persisted = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Equal(RunStatuses.Error, persisted.Status);
        Assert.NotNull(persisted.CompletedAt);
        Assert.Contains("服务重启", persisted.Error);
        var meta = await events.GetRunAsync(RunKinds.DesignArtifact, run.Id);
        Assert.NotNull(meta);
        Assert.Equal(RunStatuses.Error, meta.Status);
        Assert.Equal("DESIGN_ARTIFACT_INTERRUPTED", meta.ErrorCode);
        var records = await events.GetEventsAsync(RunKinds.DesignArtifact, run.Id, 0, 10);
        Assert.Contains(records, item => item.EventName == "error");
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task LostQueuedRun_ShouldBeReenqueuedOnlyOncePerRecoveryWindow()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-queued", now.AddMinutes(-2));
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var queue = new InMemoryRunQueue();
        var events = new InMemoryRunEventStore();

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db, queue, events, now, CancellationToken.None);
        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db, queue, events, now.AddSeconds(1), CancellationToken.None);

        Assert.Equal(run.Id, await queue.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Null(await queue.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PhaseAndCompletionWrites_ShouldPreserveNewerHeartbeatAndLease()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-minimal-updates", now);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        Assert.NotNull(await HostedSiteEditRunWorker.TryClaimAsync(
            fixture.Db, run.Id, "worker-a", now, TimeSpan.FromMinutes(2), CancellationToken.None));
        var heartbeatAt = now.AddSeconds(10);
        var leaseExpiresAt = now.AddMinutes(2).AddSeconds(10);
        Assert.True(await HostedSiteEditRunWorker.RenewLeaseAsync(
            fixture.Db, run.Id, "worker-a", heartbeatAt, TimeSpan.FromMinutes(2), CancellationToken.None));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<DesignArtifactRun>.Update.Set(x => x.RuntimeModelCallCount, 7));

        Assert.True(await HostedSiteEditRunWorker.PersistPhaseAsync(
            fixture.Db,
            run.Id,
            "worker-a",
            88,
            "正在保存",
            now.AddSeconds(20),
            CancellationToken.None));
        var afterPhase = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Equal(heartbeatAt, afterPhase.HeartbeatAt);
        Assert.Equal(leaseExpiresAt, afterPhase.LeaseExpiresAt);

        var commitAt = now.AddSeconds(30);
        Assert.True(await HostedSiteEditRunWorker.BeginCommitAsync(
            fixture.Db,
            run.Id,
            "worker-a",
            commitAt,
            TimeSpan.FromMinutes(2),
            CancellationToken.None));
        Assert.True(await HostedSiteEditRunWorker.CompleteRunAsync(
            fixture.Db,
            run.Id,
            "worker-a",
            "site-1",
            "revision-1",
            "网页已生成并保存",
            now.AddSeconds(40),
            CancellationToken.None));
        var completed = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Equal(RunStatuses.Done, completed.Status);
        Assert.Equal(commitAt, completed.HeartbeatAt);
        Assert.Equal(commitAt.AddMinutes(2), completed.LeaseExpiresAt);
        Assert.Equal("site-1", completed.ArtifactSiteId);
        Assert.Equal("revision-1", completed.ArtifactRevisionId);
        Assert.Equal(7, completed.RuntimeModelCallCount);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task WorkspacePreparation_ShouldPreserveHeartbeatAndNeverReviveRecoveredRun()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-workspace-fence", now);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        Assert.NotNull(await HostedSiteEditRunWorker.TryClaimAsync(
            fixture.Db, run.Id, "worker-a", now, TimeSpan.FromMinutes(2), CancellationToken.None));
        var heartbeatAt = now.AddMinutes(1);
        var leaseExpiresAt = now.AddMinutes(3);
        Assert.True(await HostedSiteEditRunWorker.RenewLeaseAsync(
            fixture.Db, run.Id, "worker-a", heartbeatAt, TimeSpan.FromMinutes(2), CancellationToken.None));

        Assert.True(await DesignArtifactWorkspaceBroker.PersistPreparedWorkspaceAsync(
            fixture.Db,
            run.Id,
            "worker-a",
            "input-key",
            "input-sha",
            "base-revision",
            24,
            now.AddMinutes(20),
            now.AddSeconds(10),
            CancellationToken.None));
        var prepared = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Equal(heartbeatAt, prepared.HeartbeatAt);
        Assert.Equal(leaseExpiresAt, prepared.LeaseExpiresAt);

        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.Status, RunStatuses.Error)
                .Set(x => x.Error, "已由恢复器终结"));
        Assert.False(await DesignArtifactWorkspaceBroker.PersistPreparedWorkspaceAsync(
            fixture.Db,
            run.Id,
            "worker-a",
            "late-key",
            "late-sha",
            "late-revision",
            36,
            now.AddMinutes(25),
            now.AddSeconds(20),
            CancellationToken.None));
        var terminal = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Equal(RunStatuses.Error, terminal.Status);
        Assert.Equal("input-key", terminal.WorkspaceInputAssetKey);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ExpiredLeaseOwner_ShouldNotWritePhaseCompletionOrWorkspaceMetadata()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-expired-fence", now);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        Assert.NotNull(await HostedSiteEditRunWorker.TryClaimAsync(
            fixture.Db, run.Id, "worker-a", now, TimeSpan.FromSeconds(1), CancellationToken.None));
        var afterExpiry = now.AddSeconds(2);

        Assert.False(await HostedSiteEditRunWorker.PersistPhaseAsync(
            fixture.Db, run.Id, "worker-a", 88, "陈旧阶段", afterExpiry, CancellationToken.None));
        Assert.False(await HostedSiteEditRunWorker.CompleteRunAsync(
            fixture.Db,
            run.Id,
            "worker-a",
            "late-site",
            "late-revision",
            "陈旧完成",
            afterExpiry,
            CancellationToken.None));
        Assert.False(await DesignArtifactWorkspaceBroker.PersistPreparedWorkspaceAsync(
            fixture.Db,
            run.Id,
            "worker-a",
            "late-input",
            "late-sha",
            "late-base",
            36,
            now.AddMinutes(20),
            afterExpiry,
            CancellationToken.None));

        var persisted = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Equal(RunStatuses.Running, persisted.Status);
        Assert.NotEqual("late-site", persisted.ArtifactSiteId);
        Assert.Null(persisted.WorkspaceInputAssetKey);
    }

    [Fact]
    public async Task ConsecutiveHeartbeatExceptions_ShouldCancelAtLastConfirmedDeadline()
    {
        var origin = DateTime.UtcNow;
        var clockStep = -1;
        var errors = 0;
        using var execution = new CancellationTokenSource();

        await HostedSiteEditRunWorker.RunLeaseHeartbeatLoopAsync(
            (_, _) => throw new MongoException("heartbeat unavailable"),
            origin.AddSeconds(4),
            TimeSpan.FromMinutes(2),
            TimeSpan.Zero,
            () => origin.AddSeconds(Interlocked.Increment(ref clockStep)),
            execution,
            _ => errors++);

        Assert.True(execution.IsCancellationRequested);
        Assert.True(errors >= 1);
    }

    [Theory]
    [InlineData(DesignArtifactOperations.Edit)]
    [InlineData(DesignArtifactOperations.Generate)]
    [Trait("Category", TestCategories.Integration)]
    public async Task RecoveredErrorRun_ShouldNotCreateDraftOrHostedSite(string operation)
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun($"run-no-ghost-{operation}", now);
        run.Operation = operation;
        run.TargetSiteId = operation == DesignArtifactOperations.Edit ? "site-a" : null;
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var claimed = await HostedSiteEditRunWorker.TryClaimAsync(
            fixture.Db,
            run.Id,
            "worker-a",
            now,
            TimeSpan.FromMinutes(2),
            CancellationToken.None);
        Assert.NotNull(claimed);
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            item => item.Id == run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(item => item.Status, RunStatuses.Error)
                .Set(item => item.Error, "已由恢复器终结"));
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        var editable = operation == DesignArtifactOperations.Edit
            ? new HostedSiteEditableEntry(new HostedSite { Id = "site-a" }, "<html></html>", now)
            : null;
        var parent = operation == DesignArtifactOperations.Edit
            ? new HostedSiteRevision { Id = "parent-1", SiteId = "site-a" }
            : null;

        await Assert.ThrowsAsync<DesignArtifactRunLeaseLostException>(() =>
            HostedSiteEditRunWorker.PersistArtifactWithLeaseAsync(
                fixture.Db,
                claimed!,
                "worker-a",
                "<!doctype html><html><body>safe</body></html>",
                parent,
                editable,
                sites.Object,
                revisions.Object,
                now.AddSeconds(1),
                TimeSpan.FromMinutes(2),
                CancellationToken.None));

        sites.VerifyNoOtherCalls();
        revisions.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RecoveryDuringBlockedDraftWrite_ShouldFenceAndRemoveInsertedDraft()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-blocked-draft", now);
        run.Operation = DesignArtifactOperations.Edit;
        run.TargetSiteId = "site-a";
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var claimed = await HostedSiteEditRunWorker.TryClaimAsync(
            fixture.Db, run.Id, "worker-a", now, TimeSpan.FromMinutes(2), CancellationToken.None);
        Assert.NotNull(claimed);

        var writeStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseWrite = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var draft = new HostedSiteRevision
        {
            Id = "draft-blocked",
            SiteId = "site-a",
            CreatedByUserId = run.UserId,
            Status = HostedSiteRevisionStatuses.Draft,
            Source = HostedSiteRevisionSources.AiEdit,
            SourceRunId = run.Id,
            Html = "<!doctype html><html><body>safe</body></html>",
            BasedOnContentVersion = now,
        };
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(x => x.CreateDraftAsync(
                run.TargetSiteId,
                run.UserId,
                It.IsAny<string>(),
                It.IsAny<string>(),
                It.IsAny<string>(),
                run.Id,
                It.IsAny<string>(),
                It.IsAny<IReadOnlyCollection<string>>(),
                now,
                It.IsAny<CancellationToken>()))
            .Returns(async () =>
            {
                writeStarted.TrySetResult(true);
                await releaseWrite.Task;
                await fixture.Db.HostedSiteRevisions.InsertOneAsync(draft);
                return draft;
            });
        revisions.Setup(x => x.CompensateUnpublishedDraftAsync(
                run.TargetSiteId,
                run.Id,
                run.UserId,
                draft.Id,
                CancellationToken.None))
            .Returns(async () =>
            {
                var deleted = await fixture.Db.HostedSiteRevisions.DeleteManyAsync(
                    x => x.SiteId == run.TargetSiteId
                         && x.SourceRunId == run.Id
                         && x.CreatedByUserId == run.UserId
                         && x.Status == HostedSiteRevisionStatuses.Draft);
                return deleted.DeletedCount > 0;
            });

        var persistTask = HostedSiteEditRunWorker.PersistArtifactWithLeaseAsync(
            fixture.Db,
            claimed!,
            "worker-a",
            draft.Html,
            new HostedSiteRevision { Id = "parent-1", SiteId = run.TargetSiteId },
            new HostedSiteEditableEntry(new HostedSite { Id = run.TargetSiteId }, draft.Html, now),
            sites.Object,
            revisions.Object,
            now.AddSeconds(1),
            TimeSpan.FromMinutes(2),
            CancellationToken.None);
        await writeStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.Status, RunStatuses.Error)
                .Set(x => x.Error, "恢复器已终结"));
        releaseWrite.TrySetResult(true);

        await Assert.ThrowsAsync<DesignArtifactRunLeaseLostException>(() => persistTask);
        Assert.Empty(await fixture.Db.HostedSiteRevisions.Find(x => x.SourceRunId == run.Id).ToListAsync());
        revisions.VerifyAll();
        sites.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RecoveryDuringBlockedSiteWrite_ShouldFenceAndRemoveGeneratedSite()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-blocked-site", now);
        run.Operation = DesignArtifactOperations.Generate;
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var claimed = await HostedSiteEditRunWorker.TryClaimAsync(
            fixture.Db, run.Id, "worker-a", now, TimeSpan.FromMinutes(2), CancellationToken.None);
        Assert.NotNull(claimed);

        var writeStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseWrite = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var site = new HostedSite
        {
            Id = "site-blocked",
            OwnerUserId = run.UserId,
            SourceType = "design-agent",
            SourceRef = run.Id,
            Visibility = "private",
            SiteUrl = "https://example.invalid/site-blocked",
            ContentVersion = now,
        };
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        sites.Setup(x => x.CreateFromContentAsync(
                run.UserId,
                It.IsAny<string>(),
                It.IsAny<string?>(),
                It.IsAny<string?>(),
                "design-agent",
                run.Id,
                It.IsAny<List<string>?>(),
                It.IsAny<string?>(),
                It.IsAny<CancellationToken>()))
            .Returns(async () =>
            {
                writeStarted.TrySetResult(true);
                await releaseWrite.Task;
                await fixture.Db.HostedSites.InsertOneAsync(site);
                return site;
            });
        sites.Setup(x => x.CompensateGeneratedSiteAsync(site.Id, run.Id, run.UserId, CancellationToken.None))
            .Returns(async () =>
            {
                var deleted = await fixture.Db.HostedSites.DeleteManyAsync(
                    x => x.Id == site.Id
                         && x.OwnerUserId == run.UserId
                         && x.SourceType == "design-agent"
                         && x.SourceRef == run.Id
                         && x.Visibility == "private"
                         && x.PublishedAt == null);
                await fixture.Db.HostedSiteRevisions.DeleteManyAsync(x => x.SiteId == site.Id);
                return deleted.DeletedCount > 0;
            });

        var persistTask = HostedSiteEditRunWorker.PersistArtifactWithLeaseAsync(
            fixture.Db,
            claimed!,
            "worker-a",
            "<!doctype html><html><body>safe</body></html>",
            null,
            null,
            sites.Object,
            revisions.Object,
            now.AddSeconds(1),
            TimeSpan.FromMinutes(2),
            CancellationToken.None);
        await writeStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.Status, RunStatuses.Error)
                .Set(x => x.Error, "恢复器已终结"));
        releaseWrite.TrySetResult(true);

        await Assert.ThrowsAsync<DesignArtifactRunLeaseLostException>(() => persistTask);
        Assert.Empty(await fixture.Db.HostedSites.Find(x => x.SourceRef == run.Id).ToListAsync());
        Assert.Empty(await fixture.Db.HostedSiteRevisions.Find(x => x.SiteId == site.Id).ToListAsync());
        sites.VerifyAll();
        revisions.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task CompletionFenceFailure_ShouldCompensatePersistedDraft()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-complete-fence", now);
        run.Operation = DesignArtifactOperations.Edit;
        run.TargetSiteId = "site-a";
        run.Status = RunStatuses.Error;
        run.LeaseOwnerId = "worker-a";
        run.LeaseExpiresAt = now.AddMinutes(2);
        var draft = new HostedSiteRevision
        {
            Id = "draft-complete-fence",
            SiteId = run.TargetSiteId,
            CreatedByUserId = run.UserId,
            Status = HostedSiteRevisionStatuses.Draft,
            SourceRunId = run.Id,
            Html = "<!doctype html><html><body>safe</body></html>",
            BasedOnContentVersion = now,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(draft);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(x => x.CompensateUnpublishedDraftAsync(
                draft.SiteId,
                run.Id,
                run.UserId,
                draft.Id,
                CancellationToken.None))
            .Returns(async () =>
            {
                var deleted = await fixture.Db.HostedSiteRevisions.DeleteOneAsync(x => x.Id == draft.Id);
                return deleted.DeletedCount == 1;
            });

        var completed = await HostedSiteEditRunWorker.CompleteRunOrCompensateArtifactAsync(
            fixture.Db,
            run,
            "worker-a",
            new PersistedDesignArtifact(draft.SiteId, draft.Id, draft.Status, null, null),
            sites.Object,
            revisions.Object,
            "草稿已生成",
            now.AddSeconds(1),
            CancellationToken.None);

        Assert.False(completed);
        Assert.Empty(await fixture.Db.HostedSiteRevisions.Find(x => x.Id == draft.Id).ToListAsync());
        revisions.VerifyAll();
        sites.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task DraftCompensation_ShouldKeepPublishedAndOtherRunRevisions()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var revisions = new[]
        {
            new HostedSiteRevision
            {
                Id = "draft-target",
                SiteId = "site-a",
                CreatedByUserId = "user-1",
                Status = HostedSiteRevisionStatuses.Draft,
                SourceRunId = "run-a",
                Html = "<html></html>",
                BasedOnContentVersion = now,
            },
            new HostedSiteRevision
            {
                Id = "published-target",
                SiteId = "site-a",
                CreatedByUserId = "user-1",
                Status = HostedSiteRevisionStatuses.Published,
                SourceRunId = "run-a",
                Html = "<html></html>",
                BasedOnContentVersion = now,
                PublishedAt = now,
                PublishedContentVersion = now,
            },
            new HostedSiteRevision
            {
                Id = "draft-other-run",
                SiteId = "site-a",
                CreatedByUserId = "user-1",
                Status = HostedSiteRevisionStatuses.Draft,
                SourceRunId = "run-b",
                Html = "<html></html>",
                BasedOnContentVersion = now,
            },
        };
        await fixture.Db.HostedSiteRevisions.InsertManyAsync(revisions);
        var service = new HostedSiteRevisionService(fixture.Db, Mock.Of<IHostedSiteService>());

        Assert.True(await service.CompensateUnpublishedDraftAsync(
            "site-a", "run-a", "user-1", null, CancellationToken.None));

        var remaining = await fixture.Db.HostedSiteRevisions.Find(Builders<HostedSiteRevision>.Filter.Empty).ToListAsync();
        Assert.DoesNotContain(remaining, x => x.Id == "draft-target");
        Assert.Contains(remaining, x => x.Id == "published-target");
        Assert.Contains(remaining, x => x.Id == "draft-other-run");
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task GeneratedSiteCompensation_ShouldDeleteOnlyPrivateSiteFromExactRun()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var target = new HostedSite
        {
            Id = "site-target",
            OwnerUserId = "user-1",
            SourceType = "design-agent",
            SourceRef = "run-a",
            Visibility = "private",
            Files = new List<HostedSiteFile> { new() { Path = "index.html", CosKey = "sites/target/index.html" } },
            ContentVersion = now,
        };
        var published = new HostedSite
        {
            Id = "site-published",
            OwnerUserId = "user-1",
            SourceType = "design-agent",
            SourceRef = "run-a",
            Visibility = "public",
            PublishedAt = now,
            Files = new List<HostedSiteFile> { new() { Path = "index.html", CosKey = "sites/published/index.html" } },
            ContentVersion = now,
        };
        var otherRun = new HostedSite
        {
            Id = "site-other-run",
            OwnerUserId = "user-1",
            SourceType = "design-agent",
            SourceRef = "run-b",
            Visibility = "private",
            Files = new List<HostedSiteFile> { new() { Path = "index.html", CosKey = "sites/other/index.html" } },
            ContentVersion = now,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(new DesignArtifactRun
        {
            Id = "run-a",
            UserId = "user-1",
            Status = RunStatuses.Error,
            CleanupPending = true,
        });
        await fixture.Db.HostedSites.InsertManyAsync(new[] { target, published, otherRun });
        await fixture.Db.HostedSiteRevisions.InsertManyAsync(new[]
        {
            new HostedSiteRevision { Id = "baseline-target", SiteId = target.Id, Status = HostedSiteRevisionStatuses.Published },
            new HostedSiteRevision { Id = "baseline-published", SiteId = published.Id, Status = HostedSiteRevisionStatuses.Published },
            new HostedSiteRevision { Id = "baseline-other", SiteId = otherRun.Id, Status = HostedSiteRevisionStatuses.Published },
        });
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.DeleteByKeyAsync(target.Files[0].CosKey, CancellationToken.None))
            .Returns(Task.CompletedTask);
        var service = new HostedSiteService(
            fixture.Db,
            storage.Object,
            Mock.Of<IShortLinkService>(),
            Mock.Of<ISharePasswordService>(),
            Mock.Of<ITeamService>(),
            Mock.Of<ITeamActivityService>(),
            Mock.Of<IUploadProgressService>(),
            Mock.Of<IAskOpeningQuestionGenerator>(),
            NullLogger<HostedSiteService>.Instance);

        Assert.True(await service.CompensateGeneratedSiteAsync(
            null, "run-a", "user-1", CancellationToken.None));

        var remainingSites = await fixture.Db.HostedSites.Find(Builders<HostedSite>.Filter.Empty).ToListAsync();
        Assert.DoesNotContain(remainingSites, x => x.Id == target.Id);
        Assert.Contains(remainingSites, x => x.Id == published.Id);
        Assert.Contains(remainingSites, x => x.Id == otherRun.Id);
        Assert.Empty(await fixture.Db.HostedSiteRevisions.Find(x => x.SiteId == target.Id).ToListAsync());
        Assert.NotEmpty(await fixture.Db.HostedSiteRevisions.Find(x => x.SiteId == published.Id).ToListAsync());
        Assert.NotEmpty(await fixture.Db.HostedSiteRevisions.Find(x => x.SiteId == otherRun.Id).ToListAsync());
        storage.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task KilledCommittingRunRecovery_ShouldRemoveDraftPersistedBeforeProcessExit()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-killed-draft", now.AddMinutes(-3));
        run.Operation = DesignArtifactOperations.Edit;
        run.TargetSiteId = "site-a";
        run.Status = RunStatuses.Committing;
        run.LeaseOwnerId = "dead-worker";
        run.LeaseExpiresAt = now.AddSeconds(-1);
        var draft = new HostedSiteRevision
        {
            Id = "draft-killed",
            SiteId = run.TargetSiteId,
            CreatedByUserId = run.UserId,
            Status = HostedSiteRevisionStatuses.Draft,
            SourceRunId = run.Id,
            Html = "<html></html>",
            BasedOnContentVersion = now,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(draft);
        var revisionService = new HostedSiteRevisionService(fixture.Db, Mock.Of<IHostedSiteService>());

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            new InMemoryRunEventStore(),
            now,
            CancellationToken.None,
            Mock.Of<IHostedSiteService>(),
            revisionService);

        var recovered = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Equal(RunStatuses.Error, recovered.Status);
        Assert.False(recovered.CleanupPending);
        Assert.Null(recovered.CleanupLastError);
        Assert.Empty(await fixture.Db.HostedSiteRevisions.Find(x => x.SourceRunId == run.Id).ToListAsync());
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task KilledCommittingRunRecovery_ShouldRemoveGeneratedSiteAndItsBaseline()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-killed-site", now.AddMinutes(-3));
        run.Operation = DesignArtifactOperations.Generate;
        run.Status = RunStatuses.Committing;
        run.LeaseOwnerId = "dead-worker";
        run.LeaseExpiresAt = now.AddSeconds(-1);
        var site = new HostedSite
        {
            Id = "site-killed",
            OwnerUserId = run.UserId,
            SourceType = "design-agent",
            SourceRef = run.Id,
            Visibility = "private",
            ContentVersion = now,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        await fixture.Db.HostedSites.InsertOneAsync(site);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision
        {
            Id = "baseline-killed",
            SiteId = site.Id,
            Status = HostedSiteRevisionStatuses.Published,
        });
        var siteService = CreateHostedSiteService(fixture.Db, Mock.Of<IAssetStorage>());

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            new InMemoryRunEventStore(),
            now,
            CancellationToken.None,
            siteService,
            Mock.Of<IHostedSiteRevisionService>());

        var recovered = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Equal(RunStatuses.Error, recovered.Status);
        Assert.False(recovered.CleanupPending);
        Assert.Empty(await fixture.Db.HostedSites.Find(x => x.SourceRef == run.Id).ToListAsync());
        Assert.Empty(await fixture.Db.HostedSiteRevisions.Find(x => x.SiteId == site.Id).ToListAsync());
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task FailedImmediateCleanup_ShouldPersistPendingAndSucceedOnNextReconcile()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var firstAttempt = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-cleanup-retry", firstAttempt.AddMinutes(-3));
        run.Operation = DesignArtifactOperations.Edit;
        run.TargetSiteId = "site-a";
        run.Status = RunStatuses.Error;
        var draft = new HostedSiteRevision
        {
            Id = "draft-cleanup-retry",
            SiteId = run.TargetSiteId,
            CreatedByUserId = run.UserId,
            Status = HostedSiteRevisionStatuses.Draft,
            SourceRunId = run.Id,
            Html = "<html></html>",
            BasedOnContentVersion = firstAttempt,
        };
        run.ArtifactRevisionId = draft.Id;
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(draft);
        var attempts = 0;
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(x => x.CompensateUnpublishedDraftAsync(
                run.TargetSiteId,
                run.Id,
                run.UserId,
                draft.Id,
                CancellationToken.None))
            .Returns(() =>
            {
                if (Interlocked.Increment(ref attempts) == 1)
                    throw new MongoException("cleanup unavailable");
                return fixture.Db.HostedSiteRevisions.DeleteOneAsync(x => x.Id == draft.Id)
                    .ContinueWith(task => task.Result.DeletedCount == 1, TaskScheduler.Default);
            });
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);

        Assert.False(await HostedSiteEditRunWorker.CompleteRunOrCompensateArtifactAsync(
            fixture.Db,
            run,
            "worker-a",
            new PersistedDesignArtifact(draft.SiteId, draft.Id, draft.Status, null, null),
            sites.Object,
            revisions.Object,
            "草稿已生成",
            firstAttempt,
            CancellationToken.None));
        var failed = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.True(failed.CleanupPending);
        Assert.Contains("cleanup unavailable", failed.CleanupLastError);
        Assert.Equal(firstAttempt, failed.CleanupAttemptedAt);
        Assert.NotEmpty(await fixture.Db.HostedSiteRevisions.Find(x => x.Id == draft.Id).ToListAsync());

        var secondAttempt = firstAttempt.AddSeconds(15);
        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            new InMemoryRunEventStore(),
            secondAttempt,
            CancellationToken.None,
            sites.Object,
            revisions.Object);
        var recovered = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.False(recovered.CleanupPending);
        Assert.Null(recovered.CleanupLastError);
        Assert.Equal(secondAttempt, recovered.CleanupAttemptedAt);
        Assert.Equal(2, attempts);
        Assert.Empty(await fixture.Db.HostedSiteRevisions.Find(x => x.Id == draft.Id).ToListAsync());
        sites.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    [Trait("Category", TestCategories.Integration)]
    public async Task GeneratedSiteAdoptedAfterCleanupPlan_ShouldKeepSiteAndNeverDeleteObjects(bool shareInsteadOfPublish)
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-adopted-site", now);
        run.Operation = DesignArtifactOperations.Generate;
        run.Status = RunStatuses.Error;
        run.CleanupPending = true;
        var site = new HostedSite
        {
            Id = "site-adopted",
            OwnerUserId = run.UserId,
            SourceType = "design-agent",
            SourceRef = run.Id,
            Visibility = "private",
            Files = new List<HostedSiteFile> { new() { Path = "index.html", CosKey = "sites/adopted/index.html" } },
            ContentVersion = now,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        await fixture.Db.HostedSites.InsertOneAsync(site);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        var compensated = await service.CompensateGeneratedSiteCoreAsync(
            site.Id,
            run.Id,
            run.UserId,
            async () =>
            {
                var update = shareInsteadOfPublish
                    ? Builders<HostedSite>.Update.Set(x => x.SharedTeamIds, new List<string> { "team-a" })
                    : Builders<HostedSite>.Update
                        .Set(x => x.Visibility, "public")
                        .Set(x => x.PublishedAt, DateTime.UtcNow);
                await fixture.Db.HostedSites.UpdateOneAsync(x => x.Id == site.Id, update);
            },
            CancellationToken.None);

        Assert.False(compensated);
        Assert.NotNull(await fixture.Db.HostedSites.Find(x => x.Id == site.Id).FirstOrDefaultAsync());
        var persistedRun = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.False(persistedRun.CleanupPending);
        Assert.Null(persistedRun.CleanupArtifactSiteId);
        Assert.Empty(persistedRun.CleanupAssetKeys);
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ObjectCleanupFailureAfterSiteLedgerDelete_ShouldRetryFromDurableRunPlan()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var firstAttempt = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-object-cleanup-retry", firstAttempt);
        run.Operation = DesignArtifactOperations.Generate;
        run.Status = RunStatuses.Error;
        run.CleanupPending = true;
        var site = new HostedSite
        {
            Id = "site-object-retry",
            OwnerUserId = run.UserId,
            SourceType = "design-agent",
            SourceRef = run.Id,
            Visibility = "private",
            Files = new List<HostedSiteFile> { new() { Path = "index.html", CosKey = "sites/retry/index.html" } },
            ContentVersion = firstAttempt,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        await fixture.Db.HostedSites.InsertOneAsync(site);
        await fixture.Db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision
        {
            Id = "baseline-object-retry",
            SiteId = site.Id,
            Status = HostedSiteRevisionStatuses.Published,
        });
        var storageAttempts = 0;
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.DeleteByKeyAsync(site.Files[0].CosKey, CancellationToken.None))
            .Returns(() =>
            {
                if (Interlocked.Increment(ref storageAttempts) == 1)
                    throw new IOException("object cleanup unavailable");
                return Task.CompletedTask;
            });
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            new InMemoryRunEventStore(),
            firstAttempt,
            CancellationToken.None,
            service,
            Mock.Of<IHostedSiteRevisionService>());
        var pending = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.True(pending.CleanupPending);
        Assert.True(pending.CleanupSiteRecordDeleted);
        Assert.Equal(site.Id, pending.CleanupArtifactSiteId);
        Assert.Equal(site.Files[0].CosKey, Assert.Single(pending.CleanupAssetKeys));
        Assert.Contains("object cleanup unavailable", pending.CleanupLastError);
        Assert.Null(await fixture.Db.HostedSites.Find(x => x.Id == site.Id).FirstOrDefaultAsync());
        Assert.NotEmpty(await fixture.Db.HostedSiteRevisions.Find(x => x.SiteId == site.Id).ToListAsync());

        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            new InMemoryRunEventStore(),
            firstAttempt.AddSeconds(15),
            CancellationToken.None,
            service,
            Mock.Of<IHostedSiteRevisionService>());
        var cleaned = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.False(cleaned.CleanupPending);
        Assert.False(cleaned.CleanupSiteRecordDeleted);
        Assert.Null(cleaned.CleanupArtifactSiteId);
        Assert.Empty(cleaned.CleanupAssetKeys);
        Assert.Empty(await fixture.Db.HostedSiteRevisions.Find(x => x.SiteId == site.Id).ToListAsync());
        Assert.Equal(2, storageAttempts);
        storage.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task CompetingRecoveryWhileCleanupLeaseHeld_ShouldNotClearPendingAndNextRoundTakesOver()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-cleanup-lease", now);
        run.Operation = DesignArtifactOperations.Generate;
        run.Status = RunStatuses.Error;
        run.CleanupPending = true;
        var site = new HostedSite
        {
            Id = "site-cleanup-lease",
            OwnerUserId = run.UserId,
            SourceType = "design-agent",
            SourceRef = run.Id,
            Visibility = "private",
            Files = new List<HostedSiteFile> { new() { Path = "index.html", CosKey = "sites/lease/index.html" } },
            ContentVersion = now,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        await fixture.Db.HostedSites.InsertOneAsync(site);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.DeleteByKeyAsync(site.Files[0].CosKey, CancellationToken.None))
            .Returns(Task.CompletedTask);
        var service = CreateHostedSiteService(fixture.Db, storage.Object);
        var planPersisted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        var firstCleanup = service.CompensateGeneratedSiteCoreAsync(
            site.Id,
            run.Id,
            run.UserId,
            async () =>
            {
                planPersisted.TrySetResult(true);
                await releaseFirst.Task;
                throw new IOException("first cleaner stopped");
            },
            CancellationToken.None);
        await planPersisted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var snapshot = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        await HostedSiteEditRunWorker.TryCompensateRecoveredRunAsync(
            fixture.Db,
            snapshot,
            service,
            Mock.Of<IHostedSiteRevisionService>(),
            now.AddSeconds(1));
        var whileHeld = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.True(whileHeld.CleanupPending);
        Assert.Equal(site.Id, whileHeld.CleanupArtifactSiteId);
        Assert.NotNull(whileHeld.CleanupLeaseOwnerId);
        Assert.NotNull(await fixture.Db.HostedSites.Find(x => x.Id == site.Id).FirstOrDefaultAsync());
        storage.Verify(x => x.DeleteByKeyAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);

        releaseFirst.TrySetResult(true);
        await Assert.ThrowsAsync<IOException>(() => firstCleanup);
        await HostedSiteEditRunWorker.RecoverInterruptedRunsAsync(
            fixture.Db,
            new InMemoryRunQueue(),
            new InMemoryRunEventStore(),
            now.AddSeconds(15),
            CancellationToken.None,
            service,
            Mock.Of<IHostedSiteRevisionService>());

        var completed = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.False(completed.CleanupPending);
        Assert.Null(completed.CleanupLeaseOwnerId);
        Assert.Null(completed.CleanupArtifactSiteId);
        Assert.Empty(await fixture.Db.HostedSites.Find(x => x.Id == site.Id).ToListAsync());
        storage.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task VerifiedMultiAssetCreate_ShouldPublishEveryFileAndClearPlanOnlyWhenRunCompletes()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-multi-asset", now);
        run.Operation = DesignArtifactOperations.Generate;
        run.Status = RunStatuses.Committing;
        run.LeaseOwnerId = "worker-a";
        run.LeaseExpiresAt = now.AddMinutes(2);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.BuildSiteKey(It.IsAny<string>(), It.IsAny<string>()))
            .Returns((string siteId, string filePath) => $"web-hosting/sites/{siteId}/{filePath}");
        storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>()))
            .Returns((string key) => $"https://assets.test/{key}");
        storage.Setup(x => x.UploadToKeyAsync(
                It.IsAny<string>(),
                It.IsAny<byte[]>(),
                It.IsAny<string?>(),
                CancellationToken.None,
                It.IsAny<string?>()))
            .Returns(Task.CompletedTask);
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        var site = await service.CreateFromVerifiedFilesAsync(
            run.UserId,
            BuildVerifiedGeneratedFiles(),
            "多资产页面",
            "测试",
            "design-agent",
            run.Id,
            ["知识生成"],
            null,
            "worker-a",
            CancellationToken.None);

        Assert.Equal(6, site.Files.Count);
        Assert.Equal(HostedSiteContentShapes.SelfContainedHtml, site.ContentShape);
        Assert.All(site.Files, file => Assert.StartsWith("https://assets.test/", file.Url, StringComparison.Ordinal));
        Assert.Equal(
            [
                "assets/accessibility-static-report.json",
                "assets/design-tokens.json",
                "assets/page-outline.json",
                "assets/provenance.json",
                "index.html",
                "manifest.json",
            ],
            site.Files.Select(file => file.Path).ToArray());
        var queriedSite = await service.GetByIdAsync(site.Id, run.UserId, CancellationToken.None);
        Assert.NotNull(queriedSite);
        Assert.Equal(site.Files.Select(file => file.Path), queriedSite!.Files.Select(file => file.Path));
        Assert.All(queriedSite.Files, file => Assert.StartsWith("https://assets.test/", file.Url, StringComparison.Ordinal));
        var planned = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.True(planned.CleanupPending);
        Assert.Equal(site.Id, planned.CleanupArtifactSiteId);
        Assert.Equal(site.Files.Select(file => file.CosKey).Order(), planned.CleanupAssetKeys.Order());

        Assert.True(await HostedSiteEditRunWorker.CompleteRunAsync(
            fixture.Db,
            run.Id,
            "worker-a",
            site.Id,
            "revision-1",
            "网页已生成并保存",
            now.AddSeconds(1),
            CancellationToken.None));
        var completed = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.Equal(RunStatuses.Done, completed.Status);
        Assert.False(completed.CleanupPending);
        Assert.Null(completed.CleanupArtifactSiteId);
        Assert.Empty(completed.CleanupAssetKeys);
        storage.Verify(x => x.UploadToKeyAsync(
            It.IsAny<string>(),
            It.IsAny<byte[]>(),
            It.IsAny<string?>(),
            CancellationToken.None,
            It.IsAny<string?>()), Times.Exactly(6));
        storage.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task GeneratedSidecarSite_ShouldRemainEditableAndPublishAsSingleHtmlWithDurableCleanup()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var oldHtml = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html><head><title>旧页面</title></head><body><main>旧页面</main></body></html>");
        var files = BuildVerifiedGeneratedFiles().Select(file => new HostedSiteFile
        {
            Path = file.Path,
            CosKey = $"web-hosting/sites/site-sidecar/{file.Path}",
            Size = file.Content.LongLength,
            MimeType = file.MimeType,
        }).ToList();
        var site = new HostedSite
        {
            Id = "site-sidecar",
            OwnerUserId = "user-1",
            Title = "可微调页面",
            EntryFile = "index.html",
            Files = files,
            TotalSize = files.Sum(file => file.Size),
            ContentVersion = now,
            CreatedAt = now,
            UpdatedAt = now,
            SourceType = "design-agent",
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);
        var deletedKeys = new List<string>();
        var rejectFirstCleanupAttempt = true;
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.TryDownloadBytesAsync(
                "web-hosting/sites/site-sidecar/index.html",
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(Encoding.UTF8.GetBytes(oldHtml));
        storage.Setup(x => x.UploadToKeyAsync(
                It.Is<string>(key => key.StartsWith("web-hosting/sites/site-sidecar/index.v", StringComparison.Ordinal)),
                It.IsAny<byte[]>(),
                "text/html; charset=utf-8",
                CancellationToken.None,
                It.IsAny<string?>()))
            .Returns(Task.CompletedTask);
        storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>()))
            .Returns((string key) => $"https://assets.test/{key}");
        storage.Setup(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None))
            .Callback((string key, CancellationToken _) => deletedKeys.Add(key))
            .Returns(() =>
            {
                if (rejectFirstCleanupAttempt)
                {
                    rejectFirstCleanupAttempt = false;
                    return Task.FromException(new IOException("模拟对象存储暂时不可用"));
                }
                return Task.CompletedTask;
            });
        var service = CreateHostedSiteService(fixture.Db, storage.Object);
        var editable = await service.GetEditableEntryHtmlAsync(site.Id, site.OwnerUserId, CancellationToken.None);

        var normalized = HostedSiteEditsController.ValidateEditInputCompatibility(editable);
        var published = await service.ReplaceEntryHtmlAsync(
            site.Id,
            site.OwnerUserId,
            normalized.Replace("旧页面", "新页面", StringComparison.Ordinal),
            now,
            "revision-sidecar",
            CancellationToken.None);

        Assert.Single(published.Files);
        Assert.Equal("index.html", published.Files[0].Path);
        Assert.Equal(HostedSiteContentShapes.SelfContainedHtml, published.ContentShape);
        var pending = await fixture.Db.HostedSites.Find(x => x.Id == site.Id).FirstAsync();
        Assert.Single(pending.Files);
        Assert.Equal(6, pending.PendingAssetCleanupKeys.Count);
        Assert.Equal("asset_cleanup_failed", pending.AssetCleanupLastErrorCode);

        Assert.True(await service.ResumeNextPendingAssetCleanupAsync(now.AddDays(1), CancellationToken.None));
        Assert.Equal(7, deletedKeys.Count);
        Assert.Contains("web-hosting/sites/site-sidecar/manifest.json", deletedKeys);
        var stored = await fixture.Db.HostedSites.Find(x => x.Id == site.Id).FirstAsync();
        Assert.Single(stored.Files);
        Assert.Empty(stored.PendingAssetCleanupKeys);
        storage.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task VerifiedMultiAssetCreate_WhenSecondUploadFails_ShouldRemainFullyCompensatable()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-multi-asset-failure", now);
        run.Operation = DesignArtifactOperations.Generate;
        run.Status = RunStatuses.Committing;
        run.LeaseOwnerId = "worker-a";
        run.LeaseExpiresAt = now.AddMinutes(2);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var uploadCount = 0;
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.BuildSiteKey(It.IsAny<string>(), It.IsAny<string>()))
            .Returns((string siteId, string filePath) => $"web-hosting/sites/{siteId}/{filePath}");
        storage.Setup(x => x.UploadToKeyAsync(
                It.IsAny<string>(),
                It.IsAny<byte[]>(),
                It.IsAny<string?>(),
                CancellationToken.None,
                It.IsAny<string?>()))
            .Returns(() => Interlocked.Increment(ref uploadCount) == 2
                ? Task.FromException(new IOException("second upload unavailable"))
                : Task.CompletedTask);
        storage.Setup(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None))
            .Returns(Task.CompletedTask);
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        await Assert.ThrowsAsync<IOException>(() => service.CreateFromVerifiedFilesAsync(
            run.UserId,
            BuildVerifiedGeneratedFiles(),
            "多资产页面",
            null,
            "design-agent",
            run.Id,
            null,
            null,
            "worker-a",
            CancellationToken.None));

        var planned = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.True(planned.CleanupPending);
        Assert.NotNull(planned.CleanupArtifactSiteId);
        Assert.Equal(6, planned.CleanupAssetKeys.Count);
        Assert.True(await service.CompensateGeneratedSiteAsync(
            null,
            run.Id,
            run.UserId,
            CancellationToken.None));
        var cleaned = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.False(cleaned.CleanupPending);
        Assert.Null(cleaned.CleanupArtifactSiteId);
        Assert.Empty(cleaned.CleanupAssetKeys);
        Assert.Empty(await fixture.Db.HostedSites.Find(x => x.SourceRef == run.Id).ToListAsync());
        storage.Verify(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None), Times.Exactly(6));
        storage.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task VerifiedMultiAssetCreate_WhenRecoveryCleansBeforeBlockedUploadReturns_ShouldFenceLateWrite()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-multi-asset-fenced", now);
        run.Operation = DesignArtifactOperations.Generate;
        run.Status = RunStatuses.Committing;
        run.LeaseOwnerId = "worker-a";
        run.LeaseExpiresAt = now.AddMinutes(2);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var uploadStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseUpload = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var uploadCount = 0;
        var deletedKeys = new List<string>();
        string? blockedObjectKey = null;
        var lateWriteCompleted = false;
        var lateDeleteAttemptCount = 0;
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.BuildSiteKey(It.IsAny<string>(), It.IsAny<string>()))
            .Returns((string siteId, string filePath) => $"web-hosting/sites/{siteId}/{filePath}");
        storage.Setup(x => x.UploadToKeyAsync(
                It.IsAny<string>(),
                It.IsAny<byte[]>(),
                It.IsAny<string?>(),
                CancellationToken.None,
                It.IsAny<string?>()))
            .Returns(async (string key, byte[] _, string? _, CancellationToken _, string? _) =>
            {
                if (Interlocked.Increment(ref uploadCount) != 1) return;
                blockedObjectKey = key;
                uploadStarted.SetResult();
                await releaseUpload.Task;
                lateWriteCompleted = true;
            });
        storage.Setup(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None))
            .Callback((string key, CancellationToken _) => deletedKeys.Add(key))
            .Returns((string key, CancellationToken _) =>
            {
                if (lateWriteCompleted
                    && key == blockedObjectKey
                    && Interlocked.Increment(ref lateDeleteAttemptCount) == 1)
                    return Task.FromException(new IOException("模拟晚到对象首次删除失败"));
                return Task.CompletedTask;
            });
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        var publishing = service.CreateFromVerifiedFilesAsync(
            run.UserId,
            BuildVerifiedGeneratedFiles(),
            "多资产页面",
            null,
            "design-agent",
            run.Id,
            null,
            null,
            "worker-a",
            CancellationToken.None);
        await uploadStarted.Task;
        var planned = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.True(planned.CleanupPending);
        Assert.NotNull(planned.CleanupPublishAttemptId);
        await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.Status, RunStatuses.Error)
                .Set(x => x.LeaseOwnerId, null)
                .Set(x => x.LeaseExpiresAt, null));
        Assert.True(await service.CompensateGeneratedSiteAsync(null, run.Id, run.UserId, CancellationToken.None));

        releaseUpload.SetResult();
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => publishing);

        Assert.Contains("晚到写入", error.Message, StringComparison.Ordinal);
        Assert.Equal(7, deletedKeys.Count);
        Assert.Empty(await fixture.Db.HostedSites.Find(x => x.SourceRef == run.Id).ToListAsync());
        var orphanCleanup = await fixture.Db.HostedSiteDeletionTasks
            .Find(x => x.ObjectKeys.Contains(blockedObjectKey!))
            .SingleAsync();
        Assert.Equal("asset_cleanup_failed", orphanCleanup.LastErrorCode);
        var recovered = await fixture.Db.DesignArtifactRuns.Find(x => x.Id == run.Id).FirstAsync();
        Assert.False(recovered.CleanupPending);
        Assert.Null(recovered.CleanupPublishAttemptId);

        var restartedService = CreateHostedSiteService(fixture.Db, storage.Object);
        Assert.True(await restartedService.ResumeNextPendingDeletionAsync(now.AddDays(1), CancellationToken.None));
        Assert.Equal(8, deletedKeys.Count);
        Assert.Empty(await fixture.Db.HostedSiteDeletionTasks
            .Find(x => x.Id == orphanCleanup.Id)
            .ToListAsync());
        storage.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task VerifiedMultiAssetCreate_WhenIndexNeedsSecondHardening_ShouldRejectBeforeUpload()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var files = BuildVerifiedGeneratedFiles().ToArray();
        var rawIndex = Encoding.UTF8.GetBytes(
            "<!doctype html><html><head><title>未硬化页面</title></head><body><main>未硬化页面</main></body></html>");
        var index = Array.FindIndex(files, file => file.Path == "index.html");
        files[index] = new HostedSiteVerifiedFile(
            "index.html",
            rawIndex,
            Convert.ToHexString(SHA256.HashData(rawIndex)).ToLowerInvariant(),
            "text/html; charset=utf-8");
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => service.CreateFromVerifiedFilesAsync(
            "user-1",
            files,
            "未硬化页面",
            null,
            "design-agent",
            "run-unhardened",
            null,
            null,
            "worker-a",
            CancellationToken.None));

        Assert.Contains("最终安全版本不一致", error.Message, StringComparison.Ordinal);
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task EditPersistence_ShouldPersistVerifiedPackageWithDraft()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var run = NewQueuedRun("run-edit-html-only", now);
        run.Operation = DesignArtifactOperations.Edit;
        run.TargetSiteId = "site-edit";
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var claimed = await HostedSiteEditRunWorker.TryClaimAsync(
            fixture.Db, run.Id, "worker-a", now, TimeSpan.FromMinutes(2), CancellationToken.None);
        Assert.NotNull(claimed);
        var files = BuildDesignWorkspaceFiles();
        var html = Encoding.UTF8.GetString(Convert.FromBase64String(
            files.Single(file => file.Path == "index.html").ContentBase64));
        var draft = new HostedSiteRevision { Id = "draft-html-only", SiteId = run.TargetSiteId, Status = HostedSiteRevisionStatuses.Draft };
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(x => x.CreateVerifiedDraftAsync(
                run.TargetSiteId,
                run.UserId,
                html,
                It.Is<IReadOnlyList<HostedSiteVerifiedFile>>(package => package.Count == 6),
                run.Instruction,
                run.Runtime,
                run.Id,
                "parent-1",
                It.IsAny<List<string>>(),
                now,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(draft);

        var persisted = await HostedSiteEditRunWorker.PersistArtifactWithLeaseAsync(
            fixture.Db,
            claimed!,
            "worker-a",
            html,
            new HostedSiteRevision { Id = "parent-1", SiteId = run.TargetSiteId },
            new HostedSiteEditableEntry(new HostedSite { Id = run.TargetSiteId }, html, now),
            sites.Object,
            revisions.Object,
            now.AddMilliseconds(1),
            TimeSpan.FromMinutes(2),
            CancellationToken.None,
            files);

        Assert.Equal(draft.Id, persisted.RevisionId);
        revisions.VerifyAll();
        sites.VerifyNoOtherCalls();
    }

    [Fact]
    public void VerifiedExecutorOutput_StripsOnlyTrustedCspAndRequiresExactPackageBytes()
    {
        var files = BuildDesignWorkspaceFiles();
        var packaged = Encoding.UTF8.GetString(Convert.FromBase64String(
            files.Single(file => file.Path == "index.html").ContentBase64));

        var hardened = HostedSiteEditRunWorker.HardenExecutorOutput(packaged, files);

        Assert.Equal(packaged, hardened);
        Assert.Throws<InvalidOperationException>(() =>
            HostedSiteEditRunWorker.HardenExecutorOutput(
                packaged.Replace("多资产页面", "被篡改页面", StringComparison.Ordinal),
                files));
    }

    [Fact]
    public void VerifiedPackageWhoseIndexDiffersFromWorkerHardenedHtml_ShouldBeRejected()
    {
        var files = BuildDesignWorkspaceFiles();

        var error = Assert.Throws<InvalidOperationException>(() =>
            HostedSiteEditRunWorker.BuildVerifiedHostedSiteFiles(
                files,
                "<!doctype html><html><body>另一个页面</body></html>"));

        Assert.Contains("最终安全版本不一致", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task VerifiedGeneratedBaseline_ShouldRetainCompletePackageForLaterRollback()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var files = BuildVerifiedGeneratedFiles();
        var html = Encoding.UTF8.GetString(files.Single(file => file.Path == "index.html").Content);
        var site = new HostedSite
        {
            Id = "site-verified-baseline",
            OwnerUserId = "user-1",
            ContentVersion = now,
            CreatedAt = now,
            UpdatedAt = now,
            Files = files.Select(file => new HostedSiteFile
            {
                Path = file.Path,
                CosKey = $"web-hosting/sites/site-verified-baseline/{file.Path}",
                Size = file.Content.LongLength,
                MimeType = file.MimeType,
            }).ToList(),
        };
        var entry = new HostedSiteEditableEntry(site, html, now);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var service = new HostedSiteRevisionService(fixture.Db, sites.Object);

        var baseline = await service.EnsureGeneratedVerifiedSnapshotAsync(
            site.Id,
            site.OwnerUserId,
            entry,
            files,
            HostedSiteEditRuntimes.OpenDesign,
            "run-baseline",
            ["entry-1"],
            CancellationToken.None);

        Assert.Equal(6, baseline.VerifiedFiles.Count);
        Assert.Equal(
            files.Select(file => file.Path).OrderBy(path => path, StringComparer.Ordinal),
            baseline.VerifiedFiles.Select(file => file.Path).OrderBy(path => path, StringComparer.Ordinal));
        Assert.All(baseline.VerifiedFiles, file => Assert.NotEmpty(file.Content));
        sites.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task VerifiedPackageEdit_ShouldAtomicallyRetainManifestAndAllSidecars()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var oldHtml = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html><head><title>旧页面</title></head><body><main>旧页面</main></body></html>");
        var site = new HostedSite
        {
            Id = "site-package-edit",
            OwnerUserId = "user-1",
            SourceType = "design-agent",
            EntryFile = "index.html",
            ContentVersion = now,
            CreatedAt = now,
            UpdatedAt = now,
            Files = BuildVerifiedGeneratedFiles().Select(file => new HostedSiteFile
            {
                Path = file.Path,
                CosKey = $"web-hosting/sites/site-package-edit/old/{file.Path}",
                Size = file.Content.LongLength,
                MimeType = file.MimeType,
            }).ToList(),
        };
        site.TotalSize = site.Files.Sum(file => file.Size);
        await fixture.Db.HostedSites.InsertOneAsync(site);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.TryDownloadBytesAsync(
                "web-hosting/sites/site-package-edit/old/index.html",
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(Encoding.UTF8.GetBytes(oldHtml));
        storage.Setup(x => x.BuildSiteKey(site.Id, It.IsAny<string>()))
            .Returns((string _, string filePath) => $"web-hosting/sites/site-package-edit/{filePath}");
        storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>()))
            .Returns((string key) => $"https://assets.test/{key}");
        storage.Setup(x => x.UploadToKeyAsync(
                It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string?>(),
                CancellationToken.None, It.IsAny<string?>()))
            .Returns(Task.CompletedTask);
        storage.Setup(x => x.DeleteByKeyAsync(
                It.Is<string>(key => key.Contains("/old/", StringComparison.Ordinal)),
                CancellationToken.None))
            .Returns(Task.CompletedTask);
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        var published = await service.ReplaceWithVerifiedFilesAsync(
            site.Id, site.OwnerUserId, BuildVerifiedGeneratedFiles(), now, "revision-package", CancellationToken.None);

        Assert.Equal(6, published.Files.Count);
        Assert.Contains(published.Files, file => file.Path == "manifest.json");
        Assert.All(published.Files, file => Assert.Contains("/.versions/", file.CosKey, StringComparison.Ordinal));
        Assert.Empty(published.PendingAssetCleanupKeys);
        storage.Verify(x => x.UploadToKeyAsync(
            It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string?>(),
            CancellationToken.None, It.IsAny<string?>()), Times.Exactly(6));
        storage.Verify(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None), Times.Exactly(6));
        storage.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task VerifiedPackageEdit_WhenContentVersionChangesDuringUpload_ShouldPersistAndRecoverLosingKeys()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var oldHtml = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html><head><title>旧页面</title></head><body><main>旧页面</main></body></html>");
        var site = new HostedSite
        {
            Id = "site-package-cas-loser",
            OwnerUserId = "user-1",
            SourceType = "design-agent",
            EntryFile = "index.html",
            ContentVersion = now,
            CreatedAt = now,
            UpdatedAt = now,
            Files = [new HostedSiteFile
            {
                Path = "index.html",
                CosKey = "web-hosting/sites/site-package-cas-loser/index.html",
                Size = Encoding.UTF8.GetByteCount(oldHtml),
                MimeType = "text/html",
            }],
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);
        var uploadCount = 0;
        var deleted = new List<string>();
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.TryDownloadBytesAsync(site.Files[0].CosKey, It.IsAny<CancellationToken>()))
            .ReturnsAsync(Encoding.UTF8.GetBytes(oldHtml));
        storage.Setup(x => x.BuildSiteKey(site.Id, It.IsAny<string>()))
            .Returns((string _, string filePath) => $"web-hosting/sites/{site.Id}/{filePath}");
        storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>()))
            .Returns((string key) => $"https://assets.test/{key}");
        storage.Setup(x => x.UploadToKeyAsync(
                It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string?>(),
                CancellationToken.None, It.IsAny<string?>()))
            .Returns(async () =>
            {
                if (Interlocked.Increment(ref uploadCount) != 1) return;
                await fixture.Db.HostedSites.UpdateOneAsync(
                    x => x.Id == site.Id,
                    Builders<HostedSite>.Update.Set(x => x.ContentVersion, now.AddSeconds(1)));
            });
        storage.Setup(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None))
            .Callback((string key, CancellationToken _) => deleted.Add(key))
            .Returns(Task.CompletedTask);
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.ReplaceWithVerifiedFilesAsync(
            site.Id, site.OwnerUserId, BuildVerifiedGeneratedFiles(), now, "revision-loser", CancellationToken.None));

        var afterFailure = await fixture.Db.HostedSites.Find(x => x.Id == site.Id).FirstAsync();
        Assert.Equal(6, afterFailure.PendingAssetCleanupKeys.Count);
        Assert.Empty(afterFailure.AssetPublishInProgressKeys);
        Assert.True(await service.ResumeNextPendingAssetCleanupAsync(now.AddMinutes(10), CancellationToken.None));
        Assert.Equal(6, deleted.Count);
        var recovered = await fixture.Db.HostedSites.Find(x => x.Id == site.Id).FirstAsync();
        Assert.Empty(recovered.PendingAssetCleanupKeys);
        storage.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Reupload_WhenContentVersionChangesDuringUpload_ShouldFenceAndRecoverImmutableObject()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var site = new HostedSite
        {
            Id = "site-reupload-cas-loser",
            OwnerUserId = "user-1",
            EntryFile = "index.html",
            ContentVersion = now,
            CreatedAt = now,
            UpdatedAt = now,
            Files =
            [
                new HostedSiteFile
                {
                    Path = "index.html",
                    CosKey = "web-hosting/sites/site-reupload-cas-loser/index.html",
                    Size = 16,
                    MimeType = "text/html",
                },
            ],
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);
        string? uploadedKey = null;
        var deleted = new List<string>();
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.BuildSiteKey(site.Id, It.IsAny<string>()))
            .Returns((string _, string filePath) => $"web-hosting/sites/{site.Id}/{filePath}");
        storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>()))
            .Returns((string key) => $"https://assets.test/{key}");
        storage.Setup(x => x.UploadToKeyAsync(
                It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string?>(),
                CancellationToken.None, It.IsAny<string?>()))
            .Returns(async (string key, byte[] _, string? _, CancellationToken _, string? _) =>
            {
                uploadedKey = key;
                await fixture.Db.HostedSites.UpdateOneAsync(
                    item => item.Id == site.Id,
                    Builders<HostedSite>.Update.Set(item => item.ContentVersion, now.AddSeconds(1)));
            });
        storage.Setup(x => x.DeleteByKeyAsync(It.IsAny<string>(), CancellationToken.None))
            .Callback((string key, CancellationToken _) => deleted.Add(key))
            .Returns(Task.CompletedTask);
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.ReuploadAsync(
            site.Id,
            site.OwnerUserId,
            Encoding.UTF8.GetBytes("<!doctype html><html><body>new</body></html>"),
            "index.html",
            ct: CancellationToken.None));

        Assert.NotNull(uploadedKey);
        Assert.Contains("/.versions/", uploadedKey, StringComparison.Ordinal);
        var afterFailure = await fixture.Db.HostedSites.Find(item => item.Id == site.Id).FirstAsync();
        Assert.Contains(uploadedKey, afterFailure.PendingAssetCleanupKeys);
        Assert.Empty(afterFailure.AssetPublishInProgressKeys);
        Assert.True(await service.ResumeNextPendingAssetCleanupAsync(now.AddMinutes(10), CancellationToken.None));
        Assert.Equal([uploadedKey!], deleted);
        storage.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task AssetCleanup_ShouldDeferReservedObjectUntilPublishLeaseExpires()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        const string reservedKey = "web-hosting/sites/site-active/.versions/a/index.html";
        await fixture.Db.HostedSites.InsertOneAsync(new HostedSite
        {
            Id = "site-active",
            OwnerUserId = "owner",
            Files = [new HostedSiteFile { Path = "index.html", CosKey = "web-hosting/sites/site-active/index.html" }],
            PendingAssetCleanupKeys = [reservedKey],
            AssetPublishInProgressKeys = [reservedKey],
            AssetPublishLeaseExpiresAt = now.AddMinutes(5),
            AssetCleanupNextAttemptAt = now,
        });
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        Assert.True(await service.ResumeNextPendingAssetCleanupAsync(now, CancellationToken.None));

        var deferred = await fixture.Db.HostedSites.Find(item => item.Id == "site-active").FirstAsync();
        Assert.Contains(reservedKey, deferred.PendingAssetCleanupKeys);
        Assert.Equal("asset_publish_in_progress", deferred.AssetCleanupLastErrorCode);
        Assert.Equal(now.AddMinutes(5), deferred.AssetCleanupNextAttemptAt);
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task AssetCleanup_ShouldRetainKeyReferencedByLegacySavedShare()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        const string sharedKey = "web-hosting/sites/original/manifest.json";
        await fixture.Db.HostedSites.InsertManyAsync([
            new HostedSite
            {
                Id = "original",
                OwnerUserId = "owner",
                Files = [new HostedSiteFile { Path = "index.html", CosKey = "web-hosting/sites/original/new.html" }],
                PendingAssetCleanupKeys = [sharedKey],
                AssetCleanupNextAttemptAt = now,
            },
            new HostedSite
            {
                Id = "saved",
                OwnerUserId = "reader",
                SourceType = "saved-share",
                Files = [new HostedSiteFile { Path = "manifest.json", CosKey = sharedKey }],
            },
        ]);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        Assert.True(await service.ResumeNextPendingAssetCleanupAsync(now, CancellationToken.None));

        var original = await fixture.Db.HostedSites.Find(x => x.Id == "original").FirstAsync();
        Assert.Contains(sharedKey, original.PendingAssetCleanupKeys);
        Assert.Equal("asset_still_referenced", original.AssetCleanupLastErrorCode);
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task SiteDeletion_ShouldNotDeleteObjectStillReferencedByLegacySavedShare()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        const string sharedKey = "web-hosting/sites/original/index.html";
        await fixture.Db.HostedSites.InsertManyAsync([
            new HostedSite
            {
                Id = "original",
                OwnerUserId = "owner",
                Title = "original",
                Files = [new HostedSiteFile { Path = "index.html", CosKey = sharedKey }],
            },
            new HostedSite
            {
                Id = "saved",
                OwnerUserId = "reader",
                SourceType = "saved-share",
                Files = [new HostedSiteFile { Path = "index.html", CosKey = sharedKey }],
            },
        ]);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        Assert.True(await service.DeleteAsync("original", "owner", CancellationToken.None));

        Assert.False(await fixture.Db.HostedSites.Find(item => item.Id == "original").AnyAsync());
        Assert.True(await fixture.Db.HostedSites.Find(item => item.Id == "saved").AnyAsync());
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task SaveSharedGeneratedSite_ShouldCopyObjectsAndReturnSelfContainedShape()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var now = MongoTime(DateTime.UtcNow);
        var verified = BuildVerifiedGeneratedFiles();
        var original = new HostedSite
        {
            Id = "site-share-source",
            OwnerUserId = "owner",
            SourceType = "design-agent",
            EntryFile = "index.html",
            ContentVersion = now,
            CreatedAt = now,
            UpdatedAt = now,
            Files = verified.Select(file => new HostedSiteFile
            {
                Path = file.Path,
                CosKey = $"web-hosting/sites/site-share-source/{file.Path}",
                Size = file.Content.LongLength,
                MimeType = file.MimeType,
            }).ToList(),
        };
        await fixture.Db.HostedSites.InsertOneAsync(original);
        await fixture.Db.WebPageShareLinks.InsertOneAsync(new WebPageShareLink
        {
            Id = "share-copy",
            Token = "share-copy-token",
            SiteId = original.Id,
            CreatedBy = original.OwnerUserId,
            AccessLevel = "public",
            Visibility = "public",
        });
        var bytesByKey = original.Files.ToDictionary(
            file => file.CosKey,
            file => verified.Single(source => source.Path == file.Path).Content,
            StringComparer.Ordinal);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((string key, CancellationToken _) => bytesByKey[key]);
        storage.Setup(x => x.BuildSiteKey(It.IsAny<string>(), It.IsAny<string>()))
            .Returns((string siteId, string path) => $"web-hosting/sites/{siteId}/{path}");
        storage.Setup(x => x.UploadToKeyAsync(
                It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string?>(),
                It.IsAny<CancellationToken>(), It.IsAny<string?>()))
            .Returns(Task.CompletedTask);
        storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>()))
            .Returns((string key) => $"https://assets.test/{key}");
        var service = CreateHostedSiteService(fixture.Db, storage.Object);

        var result = await service.SaveSharedSiteAsync(
            "share-copy-token", null, "reader", CancellationToken.None);

        Assert.True(result.Saved);
        var saved = Assert.Single(result.Sites);
        Assert.Equal(HostedSiteContentShapes.SelfContainedHtml, saved.ContentShape);
        Assert.All(saved.Files, file =>
        {
            Assert.StartsWith($"web-hosting/sites/{saved.Id}/", file.CosKey, StringComparison.Ordinal);
            Assert.DoesNotContain("site-share-source", file.CosKey, StringComparison.Ordinal);
        });
        var sourceAfter = await fixture.Db.HostedSites.Find(item => item.Id == original.Id).FirstAsync();
        Assert.Empty(sourceAfter.AssetPublishInProgressKeys);
        Assert.Empty(sourceAfter.PendingAssetCleanupKeys);
        storage.Verify(x => x.UploadToKeyAsync(
            It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string?>(),
            It.IsAny<CancellationToken>(), It.IsAny<string?>()), Times.Exactly(6));
        storage.VerifyAll();
    }

    private static IReadOnlyList<HostedSiteVerifiedFile> BuildVerifiedGeneratedFiles() =>
        BuildDesignWorkspaceFiles().Select(file => new HostedSiteVerifiedFile(
            file.Path,
            Convert.FromBase64String(file.ContentBase64),
            file.Sha256,
            file.MediaType)).ToArray();

    private static IReadOnlyList<DesignWorkspaceFile> BuildDesignWorkspaceFiles()
    {
        var html = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html lang=\"zh-CN\"><head><title>多资产页面</title></head><body><main><h1>多资产页面</h1></main></body></html>");
        var publicFiles = new Dictionary<string, string>
        {
            ["assets/accessibility-static-report.json"] = "{\"schemaVersion\":\"map-accessibility-static-report-v1\"}",
            ["assets/design-tokens.json"] = "{\"schemaVersion\":\"map-design-tokens-v1\"}",
            ["assets/page-outline.json"] = "{\"schemaVersion\":\"map-page-outline-v1\"}",
            ["assets/provenance.json"] = "{\"schemaVersion\":\"map-artifact-provenance-v1\"}",
            ["index.html"] = html,
        }.Select(item =>
        {
            var bytes = Encoding.UTF8.GetBytes(item.Value);
            return new DesignWorkspaceFile(
                item.Key,
                Convert.ToBase64String(bytes),
                Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                bytes.LongLength,
                item.Key == "index.html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8");
        }).OrderBy(file => file.Path, StringComparer.Ordinal).ToArray();
        var manifestFiles = publicFiles.Select(file =>
            new DesignArtifactManifestFile(file.Path, file.Sha256, file.Size, file.MediaType)).ToArray();
        var manifestBytes = JsonSerializer.SerializeToUtf8Bytes(
            new DesignArtifactManifest(
                DesignArtifactWorkspaceBroker.ManifestSchemaVersion,
                DesignArtifactWorkspaceContract.ComputePublicArtifactRevision(manifestFiles),
                "index.html",
                manifestFiles),
            DesignArtifactWorkspaceContract.JsonOptions);
        return publicFiles.Append(new DesignWorkspaceFile(
            "manifest.json",
            Convert.ToBase64String(manifestBytes),
            Convert.ToHexString(SHA256.HashData(manifestBytes)).ToLowerInvariant(),
            manifestBytes.LongLength,
            "application/json; charset=utf-8")).ToArray();
    }

    private static HostedSiteService CreateHostedSiteService(MongoDbContext db, IAssetStorage storage)
    {
        var teams = new Mock<ITeamService>();
        teams.Setup(x => x.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        return new HostedSiteService(
            db,
            storage,
            Mock.Of<IShortLinkService>(),
            Mock.Of<ISharePasswordService>(),
            teams.Object,
            Mock.Of<ITeamActivityService>(),
            Mock.Of<IUploadProgressService>(),
            Mock.Of<IAskOpeningQuestionGenerator>(),
            NullLogger<HostedSiteService>.Instance);
    }

    private static DesignArtifactRun NewQueuedRun(string id, DateTime updatedAt) => new()
    {
        Id = id,
        UserId = "user-1",
        Status = RunStatuses.Queued,
        Instruction = "生成页面",
        CreatedAt = updatedAt,
        UpdatedAt = updatedAt,
    };

    private static DateTime MongoTime(DateTime value) =>
        new(value.Ticks - value.Ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);

    private sealed class RunMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private RunMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<RunMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new RunMongoFixture(client, connectionString, $"design_run_recovery_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
