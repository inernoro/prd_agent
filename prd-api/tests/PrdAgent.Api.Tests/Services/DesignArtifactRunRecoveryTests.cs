using MongoDB.Bson;
using MongoDB.Driver;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
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

    private static HostedSiteService CreateHostedSiteService(MongoDbContext db, IAssetStorage storage) =>
        new(
            db,
            storage,
            Mock.Of<IShortLinkService>(),
            Mock.Of<ISharePasswordService>(),
            Mock.Of<ITeamService>(),
            Mock.Of<ITeamActivityService>(),
            Mock.Of<IUploadProgressService>(),
            Mock.Of<IAskOpeningQuestionGenerator>(),
            NullLogger<HostedSiteService>.Instance);

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
