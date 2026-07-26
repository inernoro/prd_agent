using PrdAgent.Api.Services;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using MongoDB.Bson;
using MongoDB.Driver;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class DocumentRecordingArchiveWorkerTests
{
    [Fact]
    public void PendingRecordingEntryId_ShouldBeDeterministicForCrashRecovery()
    {
        DocumentStoreController.PendingRecordingEntryId("session-1")
            .ShouldBe("recording-pending-session-1");
        DocumentStoreController.PendingRecordingEntryId("session-1")
            .ShouldBe(DocumentStoreController.PendingRecordingEntryId("session-1"));
    }

    [Fact]
    public void CompletedRecordingIds_ShouldBeDeterministicForCrashRecovery()
    {
        DocumentStoreController.CompletedRecordingEntryId("session-1")
            .ShouldBe("recording-completed-session-1");
        DocumentStoreController.CompletedRecordingAttachmentId("session-1")
            .ShouldBe("recording-attachment-session-1");
    }

    [Fact]
    public async Task FindRecoveredCompletedRecordingEntry_ShouldSurviveSessionCleanupAndRequireOwner()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var entry = new DocumentEntry
        {
            Id = DocumentStoreController.CompletedRecordingEntryId("expired-session"),
            StoreId = "store-1",
            Title = "recording.webm",
            CreatedBy = "user-1",
        };
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);

        var recovered = await DocumentStoreController.FindRecoveredCompletedRecordingEntryAsync(
            fixture.Db.DocumentEntries,
            "expired-session",
            "user-1",
            CancellationToken.None);
        var wrongOwner = await DocumentStoreController.FindRecoveredCompletedRecordingEntryAsync(
            fixture.Db.DocumentEntries,
            "expired-session",
            "user-2",
            CancellationToken.None);

        recovered.ShouldNotBeNull();
        recovered.Id.ShouldBe(entry.Id);
        wrongOwner.ShouldBeNull();
    }

    [Fact]
    public void CompletedEntryFallback_ShouldGuardBothStatusAndCompletionEndpoints()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());

        // 两个调用点加一个方法定义：状态查询先发现 completed，完成请求再返回同一条目。
        source.Split(
                "FindRecoveredCompletedRecordingEntryAsync(",
                StringSplitOptions.None)
            .Length.ShouldBe(4);
    }

    [Fact]
    public async Task StalePendingLeaseCompensation_ShouldDeleteOnlyItsOwnEntryAndCount()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var now = new DateTime(2026, 7, 26, 0, 0, 0, DateTimeKind.Utc);
        var store = new DocumentStore
        {
            Id = "stale-pending-lease-store",
            Name = "旧完成租约补偿测试",
            OwnerId = "user-1",
            DocumentCount = 0,
        };
        var entry = new DocumentEntry
        {
            Id = DocumentStoreController.PendingRecordingEntryId("session-1"),
            StoreId = store.Id,
            Title = "recording.webm",
            CreatedBy = "user-1",
            Metadata = new Dictionary<string, string>
            {
                [DocumentStoreController.PendingRecordingCompletionLeaseMetadataKey] = "lease-new",
            },
        };
        await fixture.Db.DocumentStores.InsertOneAsync(store);
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        (await DocumentStoreController.EnsureRecordingEntryCountedAsync(
            fixture.Db.DocumentStores,
            store.Id,
            entry.Id,
            now,
            CancellationToken.None)).ShouldBeTrue();

        (await DocumentStoreController.CompensateStalePendingRecordingEntryAsync(
            fixture.Db.DocumentEntries,
            fixture.Db.DocumentStores,
            store.Id,
            entry.Id,
            "lease-old",
            now.AddSeconds(1),
            CancellationToken.None)).ShouldBeFalse();
        (await fixture.Db.DocumentEntries.Find(e => e.Id == entry.Id).AnyAsync()).ShouldBeTrue();
        (await fixture.Db.DocumentStores.Find(s => s.Id == store.Id).SingleAsync())
            .DocumentCount.ShouldBe(1);

        (await DocumentStoreController.CompensateStalePendingRecordingEntryAsync(
            fixture.Db.DocumentEntries,
            fixture.Db.DocumentStores,
            store.Id,
            entry.Id,
            "lease-new",
            now.AddSeconds(2),
            CancellationToken.None)).ShouldBeTrue();
        (await fixture.Db.DocumentEntries.Find(e => e.Id == entry.Id).AnyAsync()).ShouldBeFalse();
        (await fixture.Db.DocumentStores.Find(s => s.Id == store.Id).SingleAsync())
            .DocumentCount.ShouldBe(0);
        var rawStore = await fixture.Db.Database
            .GetCollection<BsonDocument>("document_stores")
            .Find(Builders<BsonDocument>.Filter.Eq("_id", store.Id))
            .SingleAsync();
        rawStore[DocumentStoreController.RecordingCountedEntryIdsField]
            .AsBsonArray.Count.ShouldBe(0);
    }

    [Fact]
    public async Task PendingLeaseFencedUpsert_ShouldRejectOlderWriterAfterNewLeaseWins()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        const long oldLeaseVersion = 1;
        const long newLeaseVersion = 2;
        var entryId = DocumentStoreController.PendingRecordingEntryId("session-fenced");

        static DocumentEntry Entry(string id, string leaseId, long leaseVersion) => new()
        {
            Id = id,
            StoreId = "store-fenced",
            Title = $"{leaseId}.webm",
            CreatedBy = "user-1",
            Metadata = new Dictionary<string, string>
            {
                [DocumentStoreController.PendingRecordingCompletionLeaseMetadataKey] = leaseId,
                [DocumentStoreController.PendingRecordingCompletionLeaseVersionMetadataKey] =
                    DocumentStoreController.FormatRecordingCompletionLeaseVersion(leaseVersion),
            },
        };

        var first = await DocumentStoreController.UpsertPendingRecordingEntryForLeaseAsync(
            fixture.Db.DocumentEntries,
            Entry(entryId, "lease-old", oldLeaseVersion),
            "lease-old",
            oldLeaseVersion,
            CancellationToken.None);
        first.Inserted.ShouldBeTrue();

        var takeover = await DocumentStoreController.UpsertPendingRecordingEntryForLeaseAsync(
            fixture.Db.DocumentEntries,
            Entry(entryId, "lease-new", newLeaseVersion),
            "lease-new",
            newLeaseVersion,
            CancellationToken.None);
        takeover.LeaseOwned.ShouldBeTrue();
        takeover.Entry.Metadata[DocumentStoreController.PendingRecordingCompletionLeaseMetadataKey]
            .ShouldBe("lease-new");

        var revivedOldRequest = await DocumentStoreController.UpsertPendingRecordingEntryForLeaseAsync(
            fixture.Db.DocumentEntries,
            Entry(entryId, "lease-old", oldLeaseVersion),
            "lease-old",
            oldLeaseVersion,
            CancellationToken.None);
        revivedOldRequest.LeaseOwned.ShouldBeFalse();
        revivedOldRequest.Entry.Metadata[DocumentStoreController.PendingRecordingCompletionLeaseMetadataKey]
            .ShouldBe("lease-new");
        var persisted = await fixture.Db.DocumentEntries.Find(e => e.Id == entryId).SingleAsync();
        persisted.Title.ShouldBe("lease-new.webm");
        persisted.Metadata[DocumentStoreController.PendingRecordingCompletionLeaseMetadataKey]
            .ShouldBe("lease-new");

        for (var iteration = 0; iteration < 20; iteration++)
        {
            var concurrentEntryId = DocumentStoreController.PendingRecordingEntryId(
                $"session-concurrent-{iteration}");
            await Task.WhenAll(
                DocumentStoreController.UpsertPendingRecordingEntryForLeaseAsync(
                    fixture.Db.DocumentEntries,
                    Entry(concurrentEntryId, "lease-old", oldLeaseVersion),
                    "lease-old",
                    oldLeaseVersion,
                    CancellationToken.None),
                DocumentStoreController.UpsertPendingRecordingEntryForLeaseAsync(
                    fixture.Db.DocumentEntries,
                    Entry(concurrentEntryId, "lease-new", newLeaseVersion),
                    "lease-new",
                    newLeaseVersion,
                    CancellationToken.None));
            var concurrentWinner = await fixture.Db.DocumentEntries
                .Find(e => e.Id == concurrentEntryId)
                .SingleAsync();
            concurrentWinner.Metadata[DocumentStoreController.PendingRecordingCompletionLeaseMetadataKey]
                .ShouldBe("lease-new");
        }
    }

    [Fact]
    public void PendingLeaseCompensation_ShouldGuardBothLeaseFailureBranches()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());

        // 两个失败分支加一个方法定义：历史 pending 恢复和存储降级都必须补偿。
        source.Split(
                "CompensateStalePendingRecordingEntryAsync(",
                StringSplitOptions.None)
            .Length.ShouldBe(4);
    }

    [Fact]
    public void RecordingChunkId_ShouldBeDeterministicForConcurrentRetries()
    {
        DocumentStoreController.RecordingChunkId("session-1", 7)
            .ShouldBe("recording-chunk-session-1-7");
        DocumentStoreController.RecordingChunkId("session-1", 7)
            .ShouldBe(DocumentStoreController.RecordingChunkId("session-1", 7));
    }

    [Fact]
    public async Task EnsureRecordingChunkAsync_ShouldCollapseConcurrentRetriesToOneDocument()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var bytes = new byte[] { 1, 2, 3, 4 };
        var attempts = Enumerable.Range(0, 16)
            .Select(_ => DocumentStoreController.EnsureRecordingChunkAsync(
                fixture.Db.DocumentRecordingUploadChunks,
                "session-race",
                0,
                bytes,
                CancellationToken.None));

        var results = await Task.WhenAll(attempts);

        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            c => c.SessionId == "session-race" && c.Index == 0)).ShouldBe(1);
        results.Count(result => result.Inserted).ShouldBe(1);
        results.ShouldAllBe(result => result.PayloadMatches);
    }

    [Fact]
    public async Task EnsureRecordingChunkAsync_ShouldRejectDifferentPayloadForSameIndex()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        await DocumentStoreController.EnsureRecordingChunkAsync(
            fixture.Db.DocumentRecordingUploadChunks,
            "session-conflict",
            0,
            [1, 2, 3],
            CancellationToken.None);

        var retry = await DocumentStoreController.EnsureRecordingChunkAsync(
            fixture.Db.DocumentRecordingUploadChunks,
            "session-conflict",
            0,
            [1, 2, 4],
            CancellationToken.None);

        retry.Inserted.ShouldBeFalse();
        retry.PayloadMatches.ShouldBeFalse();
        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            c => c.SessionId == "session-conflict" && c.Index == 0)).ShouldBe(1);
    }

    [Fact]
    public void RecordingChunkRetry_ShouldRequireEveryStoredPayloadToMatch()
    {
        var requested = new byte[] { 1, 2, 3 };

        DocumentStoreController.RecordingChunkRetryMatches(
                [Chunk(0, [1, 2, 3]), Chunk(0, [1, 2, 3])],
                requested)
            .ShouldBeTrue();
        DocumentStoreController.RecordingChunkRetryMatches(
                [Chunk(0, [1, 2, 3]), Chunk(0, [1, 2, 9])],
                requested)
            .ShouldBeFalse();
        DocumentStoreController.RecordingChunkRetryMatches([], requested)
            .ShouldBeFalse();
    }

    [Fact]
    public async Task ArchiveClaim_ShouldOnlyTakeSessionsOwnedByCurrentInstance()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        await fixture.Db.DocumentRecordingUploadSessions.InsertManyAsync([
            Session("main-session", "main", DocumentRecordingArchiveStatus.Pending),
            Session("preview-session", "preview", DocumentRecordingArchiveStatus.Pending),
            Session("unowned-session", "", DocumentRecordingArchiveStatus.Pending),
        ]);

        var claimed = await DocumentRecordingArchiveWorker.ClaimOwnedArchiveSessionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            "preview",
            "preview-lease",
            DateTime.UtcNow,
            CancellationToken.None);

        claimed.ShouldNotBeNull();
        claimed!.Id.ShouldBe("preview-session");
        claimed.OwnerInstanceId.ShouldBe("preview");
        claimed.ArchiveLeaseId.ShouldBe("preview-lease");
        (await fixture.Db.DocumentRecordingUploadSessions.Find(s => s.Id == "main-session").SingleAsync())
            .ArchiveStatus.ShouldBe(DocumentRecordingArchiveStatus.Pending);
        (await fixture.Db.DocumentRecordingUploadSessions.Find(s => s.Id == "unowned-session").SingleAsync())
            .ArchiveStatus.ShouldBe(DocumentRecordingArchiveStatus.Pending);
    }

    [Fact]
    public async Task LegacyUnownedArchive_ShouldBeAdoptedByOnlyOneExplicitRequester()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var session = Session("legacy-unowned", "", DocumentRecordingArchiveStatus.Pending);
        session.Status = DocumentRecordingUploadStatus.Completed;
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);

        var results = await Task.WhenAll(
            DocumentStoreController.AdoptUnownedRecordingArchiveAsync(
                fixture.Db.DocumentRecordingUploadSessions,
                session.Id,
                session.UserId,
                "main",
                CancellationToken.None),
            DocumentStoreController.AdoptUnownedRecordingArchiveAsync(
                fixture.Db.DocumentRecordingUploadSessions,
                session.Id,
                session.UserId,
                "preview",
                CancellationToken.None));
        var adopted = await fixture.Db.DocumentRecordingUploadSessions
            .Find(s => s.Id == session.Id)
            .SingleAsync();

        results.Count(result => result).ShouldBe(1);
        new[] { "main", "preview" }.ShouldContain(adopted.OwnerInstanceId);
    }

    [Fact]
    public async Task StaleArchiveRecovery_ShouldNotReleaseAnotherInstancesLease()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var now = DateTime.UtcNow;
        var main = Session("main-stale", "main", DocumentRecordingArchiveStatus.Archiving);
        main.ArchiveLeaseId = "main-old";
        main.UpdatedAt = now.AddMinutes(-20);
        var preview = Session("preview-stale", "preview", DocumentRecordingArchiveStatus.Archiving);
        preview.ArchiveLeaseId = "preview-old";
        preview.UpdatedAt = now.AddMinutes(-20);
        await fixture.Db.DocumentRecordingUploadSessions.InsertManyAsync([main, preview]);

        var released = await DocumentRecordingArchiveWorker.ReleaseStaleOwnedArchiveLeasesAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            "preview",
            now,
            CancellationToken.None);

        released.ShouldBe(1);
        var recoveredPreview = await fixture.Db.DocumentRecordingUploadSessions
            .Find(s => s.Id == "preview-stale")
            .SingleAsync();
        recoveredPreview.ArchiveStatus.ShouldBe(DocumentRecordingArchiveStatus.Pending);
        recoveredPreview.ArchiveLeaseId.ShouldBeNull();
        var untouchedMain = await fixture.Db.DocumentRecordingUploadSessions
            .Find(s => s.Id == "main-stale")
            .SingleAsync();
        untouchedMain.ArchiveStatus.ShouldBe(DocumentRecordingArchiveStatus.Archiving);
        untouchedMain.ArchiveLeaseId.ShouldBe("main-old");
    }

    [Fact]
    public async Task CompletionClaim_ShouldIncludeFinalChunkCommittedBeforeClaim()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var session = Session("complete-after-append", "main", DocumentRecordingArchiveStatus.None);
        session.NextChunkIndex = 1;
        session.UploadedBytes = 2;
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);
        await fixture.Db.DocumentRecordingUploadChunks.InsertManyAsync([
            Chunk("complete-after-append", 0, [1, 2]),
            Chunk("complete-after-append", 1, [3, 4]),
        ]);
        await fixture.Db.DocumentRecordingUploadSessions.UpdateOneAsync(
            s => s.Id == session.Id
                 && s.Status == DocumentRecordingUploadStatus.Uploading
                 && s.NextChunkIndex == 1,
            Builders<DocumentRecordingUploadSession>.Update
                .Set(s => s.NextChunkIndex, 2)
                .Set(s => s.UploadedBytes, 4));

        var claimed = await DocumentStoreController.ClaimRecordingCompletionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            session.UserId,
            "completion-lease",
            DateTime.UtcNow,
            CancellationToken.None);
        var chunks = await fixture.Db.DocumentRecordingUploadChunks
            .Find(c => c.SessionId == session.Id)
            .SortBy(c => c.Index)
            .ToListAsync();

        claimed.ShouldNotBeNull();
        claimed!.NextChunkIndex.ShouldBe(2);
        claimed.UploadedBytes.ShouldBe(4);
        DocumentRecordingArchiveWorker.AssembleChunks(
                chunks,
                claimed.NextChunkIndex,
                claimed.UploadedBytes)
            .ShouldBe(new byte[] { 1, 2, 3, 4 });
    }

    [Fact]
    public async Task CompletionClaim_ShouldBlockAndExcludeAppendThatHasNotCommitted()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var session = Session("complete-before-append", "main", DocumentRecordingArchiveStatus.None);
        session.NextChunkIndex = 1;
        session.UploadedBytes = 2;
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);
        await fixture.Db.DocumentRecordingUploadChunks.InsertManyAsync([
            Chunk("complete-before-append", 0, [1, 2]),
            Chunk("complete-before-append", 1, [3, 4]),
        ]);

        var claimed = await DocumentStoreController.ClaimRecordingCompletionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            session.UserId,
            "completion-lease",
            DateTime.UtcNow,
            CancellationToken.None);
        var appendCommit = await fixture.Db.DocumentRecordingUploadSessions.UpdateOneAsync(
            s => s.Id == session.Id
                 && s.Status == DocumentRecordingUploadStatus.Uploading
                 && s.NextChunkIndex == 1,
            Builders<DocumentRecordingUploadSession>.Update
                .Set(s => s.NextChunkIndex, 2)
                .Set(s => s.UploadedBytes, 4));
        await fixture.Db.DocumentRecordingUploadChunks.DeleteOneAsync(
            c => c.SessionId == session.Id && c.Index == 1);
        var acceptedChunks = await fixture.Db.DocumentRecordingUploadChunks
            .Find(c => c.SessionId == session.Id)
            .ToListAsync();

        claimed.ShouldNotBeNull();
        appendCommit.ModifiedCount.ShouldBe(0);
        claimed!.NextChunkIndex.ShouldBe(1);
        DocumentRecordingArchiveWorker.AssembleChunks(
                acceptedChunks,
                claimed.NextChunkIndex,
                claimed.UploadedBytes)
            .ShouldBe(new byte[] { 1, 2 });
    }

    [Fact]
    public async Task CompletionLease_ShouldPreventOldClaimFromReleasingNewClaim()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var session = Session("completion-fence", "main", DocumentRecordingArchiveStatus.None);
        session.UpdatedAt = DateTime.UtcNow.AddMinutes(-20);
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);
        var first = await DocumentStoreController.ClaimRecordingCompletionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            session.UserId,
            "old-lease",
            DateTime.UtcNow.AddMinutes(-20),
            CancellationToken.None);
        first.ShouldNotBeNull();
        first!.CompletionLeaseVersion.ShouldBe(1);
        var second = await DocumentStoreController.ClaimRecordingCompletionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            session.UserId,
            "new-lease",
            DateTime.UtcNow,
            CancellationToken.None);
        second.ShouldNotBeNull();
        second!.CompletionLeaseVersion.ShouldBe(2);

        var oldReleased = await DocumentStoreController.ReleaseRecordingCompletionClaimAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            session.UserId,
            "old-lease",
            CancellationToken.None);
        var current = await fixture.Db.DocumentRecordingUploadSessions
            .Find(s => s.Id == session.Id)
            .SingleAsync();

        oldReleased.ShouldBeFalse();
        current.Status.ShouldBe(DocumentRecordingUploadStatus.Completing);
        current.CompletionLeaseId.ShouldBe("new-lease");
    }

    [Fact]
    public async Task CompletionLeaseHeartbeat_ShouldBlockEarlyReclaimAndFenceExpiredOwner()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var t0 = DateTime.UtcNow;
        var session = Session("completion-heartbeat", "main", DocumentRecordingArchiveStatus.None);
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);

        var first = await DocumentStoreController.ClaimRecordingCompletionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            session.UserId,
            "old-lease",
            t0,
            CancellationToken.None);
        first.ShouldNotBeNull();

        var refreshed = await DocumentStoreController.RefreshRecordingCompletionLeaseAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            session.UserId,
            "old-lease",
            t0.AddMinutes(10),
            CancellationToken.None);
        refreshed.ShouldBeTrue();

        var blocked = await DocumentStoreController.ClaimRecordingCompletionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            session.UserId,
            "new-lease",
            t0.AddMinutes(20),
            CancellationToken.None);
        blocked.ShouldBeNull();

        var reclaimed = await DocumentStoreController.ClaimRecordingCompletionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            session.UserId,
            "new-lease",
            t0.AddMinutes(26),
            CancellationToken.None);
        reclaimed.ShouldNotBeNull();
        reclaimed!.CompletionLeaseId.ShouldBe("new-lease");
        reclaimed.CompletionLeaseVersion.ShouldBe(2);

        var expiredOwnerRefresh = await DocumentStoreController.RefreshRecordingCompletionLeaseAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            session.UserId,
            "old-lease",
            t0.AddMinutes(27),
            CancellationToken.None);
        expiredOwnerRefresh.ShouldBeFalse();
    }

    [Fact]
    public async Task RecordingEntryCount_ShouldApplyExactlyOnceAcrossRetries()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var t0 = new DateTime(2026, 7, 24, 0, 0, 0, DateTimeKind.Utc);
        var store = new DocumentStore
        {
            Id = "recording-count-idempotent",
            Name = "录音计数幂等测试",
            OwnerId = "user-1",
            DocumentCount = 1,
            UpdatedAt = t0,
        };
        await fixture.Db.DocumentStores.InsertOneAsync(store);

        var first = await DocumentStoreController.EnsureRecordingEntryCountedAsync(
            fixture.Db.DocumentStores,
            store.Id,
            "recording-entry-1",
            t0.AddMinutes(1),
            CancellationToken.None);
        var retry = await DocumentStoreController.EnsureRecordingEntryCountedAsync(
            fixture.Db.DocumentStores,
            store.Id,
            "recording-entry-1",
            t0.AddMinutes(2),
            CancellationToken.None);

        first.ShouldBeTrue();
        retry.ShouldBeFalse();
        (await fixture.Db.DocumentStores.Find(s => s.Id == store.Id).SingleAsync())
            .DocumentCount.ShouldBe(2);
    }

    [Fact]
    public void InterruptedCompletedEntryRecovery_ShouldCountBeforeFinalizing()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());
        var recoveryStart = source.IndexOf(
            "if (interruptedAttachment != null && !string.IsNullOrWhiteSpace(interruptedAttachment.Url))",
            StringComparison.Ordinal);
        recoveryStart.ShouldBeGreaterThanOrEqualTo(0);
        var recoveryEnd = source.IndexOf(
            "var interruptedPendingEntry =",
            recoveryStart,
            StringComparison.Ordinal);
        recoveryEnd.ShouldBeGreaterThan(recoveryStart);
        var recoveryBlock = source[recoveryStart..recoveryEnd];

        var ensureCounted = recoveryBlock.IndexOf(
            "await EnsureRecordingEntryCountedAsync(",
            StringComparison.Ordinal);
        var finalize = recoveryBlock.IndexOf(
            "if (!await FinalizeCompletedRecordingAsync(",
            StringComparison.Ordinal);
        ensureCounted.ShouldBeGreaterThanOrEqualTo(0);
        finalize.ShouldBeGreaterThan(ensureCounted);
    }

    [Fact]
    public async Task InterruptedCompletedEntryRecovery_ShouldRestoreMissingCountExactlyOnce()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var t0 = new DateTime(2026, 7, 24, 0, 0, 0, DateTimeKind.Utc);
        var store = new DocumentStore
        {
            Id = "recording-recovered-missing-count",
            Name = "录音恢复补记测试",
            OwnerId = "user-1",
            DocumentCount = 4,
            UpdatedAt = t0,
        };
        const string entryId = "recording-completed-interrupted-before-count";
        await fixture.Db.DocumentStores.InsertOneAsync(store);

        (await DocumentStoreController.EnsureRecordingEntryCountedAsync(
            fixture.Db.DocumentStores,
            store.Id,
            entryId,
            t0.AddSeconds(1),
            CancellationToken.None)).ShouldBeTrue();
        (await DocumentStoreController.EnsureRecordingEntryCountedAsync(
            fixture.Db.DocumentStores,
            store.Id,
            entryId,
            t0.AddSeconds(2),
            CancellationToken.None)).ShouldBeFalse();
        await DocumentStoreController.ReleaseRecordingCountTokensAsync(
            fixture.Db.DocumentStores,
            store.Id,
            [entryId],
            t0.AddSeconds(3),
            CancellationToken.None);

        var stored = await fixture.Db.DocumentStores.Find(s => s.Id == store.Id).SingleAsync();
        stored.DocumentCount.ShouldBe(5);
        var rawStore = await fixture.Db.Database
            .GetCollection<BsonDocument>("document_stores")
            .Find(Builders<BsonDocument>.Filter.Eq("_id", store.Id))
            .SingleAsync();
        rawStore[DocumentStoreController.RecordingCountedEntryIdsField]
            .AsBsonArray.Count.ShouldBe(0);
    }

    [Fact]
    public async Task RecordingEntryCount_ShouldCommuteWithConcurrentNormalAddition()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var t0 = new DateTime(2026, 7, 24, 0, 0, 0, DateTimeKind.Utc);
        var store = new DocumentStore
        {
            Id = "recording-count-add-race",
            Name = "录音计数竞态测试",
            OwnerId = "user-1",
            DocumentCount = 2,
            UpdatedAt = t0,
        };
        await fixture.Db.DocumentStores.InsertOneAsync(store);

        await Task.WhenAll(
            fixture.Db.DocumentStores.UpdateOneAsync(
                s => s.Id == store.Id,
                Builders<DocumentStore>.Update
                    .Inc(s => s.DocumentCount, 1)
                    .Set(s => s.UpdatedAt, t0.AddSeconds(1))),
            DocumentStoreController.EnsureRecordingEntryCountedAsync(
                fixture.Db.DocumentStores,
                store.Id,
                "recording-entry-race",
                t0.AddSeconds(2),
                CancellationToken.None));

        (await fixture.Db.DocumentStores.Find(s => s.Id == store.Id).SingleAsync())
            .DocumentCount.ShouldBe(4);
    }

    [Fact]
    public async Task RecordingEntryCountTokens_ShouldBeTransientAcrossCompletedSessions()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var t0 = new DateTime(2026, 7, 24, 0, 0, 0, DateTimeKind.Utc);
        var store = new DocumentStore
        {
            Id = "recording-count-bounded-tokens",
            Name = "录音计数令牌容量测试",
            OwnerId = "user-1",
            DocumentCount = 0,
            UpdatedAt = t0,
        };
        await fixture.Db.DocumentStores.InsertOneAsync(store);

        for (var index = 0; index < 256; index++)
        {
            var entryId = $"recording-completed-session-{index}";
            (await DocumentStoreController.EnsureRecordingEntryCountedAsync(
                fixture.Db.DocumentStores,
                store.Id,
                entryId,
                t0.AddSeconds(index * 2),
                CancellationToken.None)).ShouldBeTrue();
            await DocumentStoreController.ReleaseRecordingCountTokensAsync(
                fixture.Db.DocumentStores,
                store.Id,
                [entryId],
                t0.AddSeconds(index * 2 + 1),
                CancellationToken.None);
        }

        var stored = await fixture.Db.DocumentStores.Find(s => s.Id == store.Id).SingleAsync();
        stored.DocumentCount.ShouldBe(256);
        var rawStore = await fixture.Db.Database
            .GetCollection<BsonDocument>("document_stores")
            .Find(Builders<BsonDocument>.Filter.Eq("_id", store.Id))
            .SingleAsync();
        rawStore[DocumentStoreController.RecordingCountedEntryIdsField]
            .AsBsonArray.Count.ShouldBe(0);
    }

    [Fact]
    public async Task RecordingEntryCountToken_ShouldBeRemovedWithDeletedEntry()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var t0 = new DateTime(2026, 7, 24, 0, 0, 0, DateTimeKind.Utc);
        var store = new DocumentStore
        {
            Id = "recording-count-token-cleanup",
            Name = "录音计数令牌清理测试",
            OwnerId = "user-1",
            DocumentCount = 0,
            UpdatedAt = t0,
        };
        const string entryId = "recording-completed-session-cleanup";
        await fixture.Db.DocumentStores.InsertOneAsync(store);
        (await DocumentStoreController.EnsureRecordingEntryCountedAsync(
            fixture.Db.DocumentStores,
            store.Id,
            entryId,
            t0.AddSeconds(1),
            CancellationToken.None)).ShouldBeTrue();

        await DocumentStoreController.ApplyDocumentCountDeletionAsync(
            fixture.Db.DocumentStores,
            store.Id,
            deletedCount: 1,
            now: t0.AddSeconds(2),
            cancellationToken: CancellationToken.None,
            countedRecordingEntryIds: [entryId]);
        (await DocumentStoreController.EnsureRecordingEntryCountedAsync(
            fixture.Db.DocumentStores,
            store.Id,
            entryId,
            t0.AddSeconds(3),
            CancellationToken.None)).ShouldBeTrue();

        (await fixture.Db.DocumentStores.Find(s => s.Id == store.Id).SingleAsync())
            .DocumentCount.ShouldBe(1);
    }

    [Fact]
    public async Task DocumentCountDeletion_ShouldCommuteWithConcurrentAddition()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var t0 = new DateTime(2026, 7, 24, 0, 0, 0, DateTimeKind.Utc);
        var store = new DocumentStore
        {
            Id = "document-count-add-delete-race",
            Name = "文档增删计数竞态测试",
            OwnerId = "user-1",
            DocumentCount = 2,
            UpdatedAt = t0,
        };
        await fixture.Db.DocumentStores.InsertOneAsync(store);

        await Task.WhenAll(
            fixture.Db.DocumentStores.UpdateOneAsync(
                s => s.Id == store.Id,
                Builders<DocumentStore>.Update
                    .Inc(s => s.DocumentCount, 1)
                    .Set(s => s.UpdatedAt, t0.AddSeconds(1))),
            DocumentStoreController.ApplyDocumentCountDeletionAsync(
                fixture.Db.DocumentStores,
                store.Id,
                deletedCount: 1,
                now: t0.AddSeconds(2),
                CancellationToken.None));

        (await fixture.Db.DocumentStores.Find(s => s.Id == store.Id).SingleAsync())
            .DocumentCount.ShouldBe(2);
    }

    [Fact]
    public async Task DocumentCountDeletion_ShouldClampInsteadOfGoingNegative()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var t0 = new DateTime(2026, 7, 24, 0, 0, 0, DateTimeKind.Utc);
        var store = new DocumentStore
        {
            Id = "document-count-delete-undercount",
            Name = "文档删除少计恢复测试",
            OwnerId = "user-1",
            DocumentCount = 0,
            UpdatedAt = t0,
        };
        await fixture.Db.DocumentStores.InsertOneAsync(store);

        await DocumentStoreController.ApplyDocumentCountDeletionAsync(
            fixture.Db.DocumentStores,
            store.Id,
            deletedCount: 1,
            now: t0.AddSeconds(1),
            CancellationToken.None);

        (await fixture.Db.DocumentStores.Find(s => s.Id == store.Id).SingleAsync())
            .DocumentCount.ShouldBe(0);
    }

    [Fact]
    public void RecoveryEntryIds_ShouldCheckCompletedBeforePending()
    {
        DocumentStoreController.RecordingRecoveryEntryIds("session-1")
            .ShouldBe([
                "recording-completed-session-1",
                "recording-pending-session-1",
            ]);
    }

    [Fact]
    public async Task CleanupExpiredRecordingUploads_ShouldDeleteChunksBeforeSessions()
    {
        var calls = new List<string>();

        await DocumentStoreController.CleanupExpiredRecordingUploadsAsync(
            ["session-1"],
            _ =>
            {
                calls.Add("chunks");
                return Task.CompletedTask;
            },
            _ =>
            {
                calls.Add("sessions");
                return Task.CompletedTask;
            });

        calls.ShouldBe(["chunks", "sessions"]);
    }

    [Fact]
    public async Task CleanupExpiredRecordingUploads_ShouldRetainSessionWhenChunkDeletionFails()
    {
        var sessionsDeleted = false;

        await Should.ThrowAsync<InvalidOperationException>(() =>
            DocumentStoreController.CleanupExpiredRecordingUploadsAsync(
                ["session-1"],
                _ => throw new InvalidOperationException("chunk delete failed"),
                _ =>
                {
                    sessionsDeleted = true;
                    return Task.CompletedTask;
                }));

        sessionsDeleted.ShouldBeFalse();
    }

    [Fact]
    public void FindOrphanedRecordingSessionIds_ShouldIgnoreChunksWithExistingParents()
    {
        var orphaned = DocumentStoreController.FindOrphanedRecordingSessionIds(
            ["cancelled-session", "active-session", "cancelled-session"],
            ["active-session"]);

        orphaned.ShouldBe(["cancelled-session"]);
    }

    [Theory]
    [InlineData(DocumentRecordingUploadStatus.Uploading, true)]
    [InlineData(DocumentRecordingUploadStatus.Completing, true)]
    [InlineData(DocumentRecordingUploadStatus.Completed, false)]
    [InlineData(DocumentRecordingUploadStatus.Cancelled, false)]
    public void CompletionEntryGuard_ShouldAllowStaleLeaseRecovery(string status, bool expected)
    {
        DocumentStoreController.CanEnterRecordingCompletion(status).ShouldBe(expected);
    }

    [Fact]
    public void AssembleChunks_ShouldRestoreOrderedAudio()
    {
        var chunks = new[]
        {
            Chunk(0, [1, 2]),
            Chunk(1, [3, 4, 5]),
        };

        var result = DocumentRecordingArchiveWorker.AssembleChunks(chunks, 2, 5);

        result.ShouldBe(new byte[] { 1, 2, 3, 4, 5 });
    }

    [Fact]
    public void AssembleChunks_ShouldRejectGapWithoutDeletingData()
    {
        var chunks = new[]
        {
            Chunk(0, [1, 2]),
            Chunk(2, [3, 4]),
        };

        Should.Throw<InvalidOperationException>(() =>
            DocumentRecordingArchiveWorker.AssembleChunks(chunks, 2, 4))
            .Message.ShouldContain("第 1 个分片");
    }

    [Fact]
    public void AssembleChunks_ShouldRecoverIdenticalLegacyDuplicates()
    {
        var chunks = new[]
        {
            Chunk(0, [1, 2]),
            Chunk(0, [1, 2]),
            Chunk(1, [3, 4]),
        };

        DocumentRecordingArchiveWorker.AssembleChunks(chunks, 2, 4)
            .ShouldBe(new byte[] { 1, 2, 3, 4 });
    }

    [Fact]
    public void AssembleChunks_ShouldRejectConflictingLegacyDuplicates()
    {
        var chunks = new[]
        {
            Chunk(0, [1, 2]),
            Chunk(0, [1, 9]),
            Chunk(1, [3, 4]),
        };

        Should.Throw<InvalidOperationException>(() =>
                DocumentRecordingArchiveWorker.AssembleChunks(chunks, 2, 4))
            .Message.ShouldContain("第 0 个分片存在内容冲突");
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(3, 8)]
    [InlineData(20, 256)]
    public void ComputeBackoff_ShouldBeBounded(int attempts, int expectedMinutes)
    {
        DocumentRecordingArchiveWorker.ComputeBackoff(attempts)
            .ShouldBe(TimeSpan.FromMinutes(expectedMinutes));
    }

    [Fact]
    public void BuildDeferredTranscriptionRun_ShouldQueueMissingLiveTranscriptExactlyOnce()
    {
        var session = new DocumentRecordingUploadSession
        {
            Id = "session-1",
            StoreId = "store-1",
            UserId = "user-1",
            LiveTranscriptStatus = DocumentLiveTranscriptStatus.Degraded,
        };

        var run = DocumentRecordingArchiveWorker.BuildDeferredTranscriptionRun(
            session,
            "entry-1",
            "instance-1",
            entryRequiresDeferredTranscription: true);

        run.ShouldNotBeNull();
        run!.Id.ShouldBe("recording-archive-transcribe-session-1");
        run.Kind.ShouldBe(DocumentStoreAgentRunKind.Transcribe);
        run.SourceEntryId.ShouldBe("entry-1");
        run.StoreId.ShouldBe("store-1");
        run.UserId.ShouldBe("user-1");
        run.OwnerInstanceId.ShouldBe("instance-1");
        run.Status.ShouldBe(DocumentStoreRunStatus.Queued);
    }

    [Fact]
    public void BuildDeferredTranscriptionRun_ShouldSkipCompletedLiveTranscript()
    {
        var session = new DocumentRecordingUploadSession
        {
            Id = "session-2",
            StoreId = "store-1",
            UserId = "user-1",
            LiveTranscriptStatus = DocumentLiveTranscriptStatus.Completed,
            LiveTranscript = "完整实时原文",
        };

        DocumentRecordingArchiveWorker.BuildDeferredTranscriptionRun(
                session,
                "entry-2",
                "instance-1",
                entryRequiresDeferredTranscription: false)
            .ShouldBeNull();
    }

    [Fact]
    public void BuildDeferredTranscriptionRun_ShouldQueueWhenLiveTranscriptArrivesAfterPendingEntry()
    {
        var session = new DocumentRecordingUploadSession
        {
            Id = "session-late-live",
            StoreId = "store-1",
            UserId = "user-1",
            LiveTranscriptStatus = DocumentLiveTranscriptStatus.Completed,
            LiveTranscript = "晚到的完整实时原文",
        };

        var run = DocumentRecordingArchiveWorker.BuildDeferredTranscriptionRun(
            session,
            "entry-late-live",
            "instance-1",
            entryRequiresDeferredTranscription: true);

        run.ShouldNotBeNull();
        run!.Id.ShouldBe("recording-archive-transcribe-session-late-live");
        run.SourceEntryId.ShouldBe("entry-late-live");
    }

    [Fact]
    public void DeferredTranscriptionRunIdForClient_ShouldPreserveIntentAcrossLateTranscriptAndResponseRetry()
    {
        var entry = new DocumentEntry
        {
            Id = "entry-late-live",
            Metadata = new Dictionary<string, string>
            {
                ["liveTranscriptStatus"] = DocumentLiveTranscriptStatus.Completed,
                ["liveTranscript"] = "晚到的完整实时原文",
                [DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey] = "true",
            },
        };

        DocumentRecordingArchiveWorker.DeferredTranscriptionRunIdForClient(
                archivePending: true,
                entry,
                "session-late-live")
            .ShouldBe("recording-archive-transcribe-session-late-live");
        DocumentRecordingArchiveWorker.DeferredTranscriptionRunIdForClient(
                archivePending: false,
                entry,
                "session-late-live")
            .ShouldBeNull();

        entry.Metadata.Remove(DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey);
        DocumentRecordingArchiveWorker.DeferredTranscriptionRunIdForClient(
                archivePending: true,
                entry,
                "session-late-live")
            .ShouldBeNull();
    }

    [Fact]
    public async Task FinalizeArchivedEntry_ShouldIndexLateLiveTranscriptAndPreserveRunSignal()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        if (fixture == null) return;

        var entry = new DocumentEntry
        {
            Id = "entry-late-live",
            StoreId = "store-1",
            Title = "recording.webm",
            Metadata = new Dictionary<string, string>
            {
                ["audioArchiveStatus"] = DocumentRecordingArchiveStatus.Pending,
            },
        };
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        var transcript = new string('a', 2100);
        var session = new DocumentRecordingUploadSession
        {
            Id = "session-late-live",
            StoreId = "store-1",
            UserId = "user-1",
            LiveTranscriptStatus = DocumentLiveTranscriptStatus.Completed,
            LiveTranscript = transcript,
            LiveTranscriptProvider = "provider-1",
            LiveTranscriptModel = "model-1",
        };

        DocumentRecordingArchiveWorker.HasCompletedLiveTranscript(entry).ShouldBeFalse();
        DocumentRecordingArchiveWorker.RequiresDeferredTranscription(entry).ShouldBeTrue();
        await DocumentRecordingArchiveWorker.FinalizeArchivedEntryAsync(
            fixture.Db.DocumentEntries,
            entry.Id,
            "attachment-1",
            session,
            entryRequiresDeferredTranscription: true,
            cancellationToken: CancellationToken.None);

        var updated = await fixture.Db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync();
        updated.AttachmentId.ShouldBe("attachment-1");
        updated.Summary.ShouldBe(transcript[..200]);
        updated.ContentIndex.ShouldBe(transcript[..2000]);
        updated.Metadata["audioArchiveStatus"].ShouldBe(DocumentRecordingArchiveStatus.Completed);
        updated.Metadata["liveTranscriptStatus"].ShouldBe(DocumentLiveTranscriptStatus.Completed);
        updated.Metadata["liveTranscript"].ShouldBe(transcript);
        updated.Metadata["liveTranscriptProvider"].ShouldBe("provider-1");
        updated.Metadata["liveTranscriptModel"].ShouldBe("model-1");
        updated.Metadata[DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey]
            .ShouldBe("true");
        updated.Metadata[DocumentRecordingArchiveWorker.DeferredTranscriptionRunIdMetadataKey]
            .ShouldBe("recording-archive-transcribe-session-late-live");
        updated.LastChangedAt.ShouldNotBeNull();
        DocumentRecordingArchiveWorker.HasCompletedLiveTranscript(updated).ShouldBeTrue();
        DocumentRecordingArchiveWorker.RequiresDeferredTranscription(updated).ShouldBeTrue();
    }

    private static DocumentRecordingUploadChunk Chunk(int index, byte[] data)
        => new()
        {
            SessionId = "session",
            Index = index,
            Data = data,
            SizeBytes = data.LongLength,
        };

    private static DocumentRecordingUploadChunk Chunk(string sessionId, int index, byte[] data)
        => new()
        {
            Id = DocumentStoreController.RecordingChunkId(sessionId, index),
            SessionId = sessionId,
            Index = index,
            Data = data,
            SizeBytes = data.LongLength,
        };

    private static DocumentRecordingUploadSession Session(
        string id,
        string ownerInstanceId,
        string archiveStatus)
        => new()
        {
            Id = id,
            StoreId = "store-1",
            UserId = "user-1",
            OwnerInstanceId = ownerInstanceId,
            FileName = "recording.webm",
            MimeType = "audio/webm",
            ArchiveStatus = archiveStatus,
        };

    private sealed class RecordingMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private RecordingMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        public MongoDbContext Db { get; }

        public static async Task<RecordingMongoFixture?> TryCreateAsync()
        {
            var configuredConnectionString = Environment.GetEnvironmentVariable("ADMIN_PUSH_TEST_MONGO_URI");
            var connectionString = configuredConnectionString ?? "mongodb://localhost:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(2);
            var client = new MongoClient(settings);
            try
            {
                await client.GetDatabase("admin").RunCommandAsync<MongoDB.Bson.BsonDocument>(
                    new MongoDB.Bson.BsonDocument("ping", 1));
            }
            catch when (string.IsNullOrWhiteSpace(configuredConnectionString))
            {
                return null;
            }

            return new RecordingMongoFixture(
                client,
                connectionString,
                $"recording_chunk_race_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync()
            => await _client.DropDatabaseAsync(_databaseName);
    }

    private static string DocumentStoreControllerPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var path = Path.Combine(
                dir.FullName,
                "prd-api",
                "src",
                "PrdAgent.Api",
                "Controllers",
                "Api",
                "DocumentStoreController.cs");
            if (File.Exists(path)) return path;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate DocumentStoreController.cs from test base directory.");
    }
}
