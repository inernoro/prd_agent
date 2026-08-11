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
    public async Task FindRecoveredRecordingEntry_ShouldRecoverBothArchiveFormsAndRequireOwner()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

        var completedEntry = new DocumentEntry
        {
            Id = DocumentStoreController.CompletedRecordingEntryId("completed-session"),
            StoreId = "store-1",
            Title = "completed-recording.webm",
            CreatedBy = "user-1",
        };
        var archivedPendingEntry = new DocumentEntry
        {
            Id = DocumentStoreController.PendingRecordingEntryId("archived-pending-session"),
            StoreId = "store-1",
            Title = "archived-pending-recording.webm",
            CreatedBy = "user-1",
        };
        await fixture.Db.DocumentEntries.InsertManyAsync([completedEntry, archivedPendingEntry]);

        var recoveredCompleted = await DocumentStoreController.FindRecoveredRecordingEntryAsync(
            fixture.Db.DocumentEntries,
            "completed-session",
            "user-1",
            CancellationToken.None);
        var recoveredArchivedPending = await DocumentStoreController.FindRecoveredRecordingEntryAsync(
            fixture.Db.DocumentEntries,
            "archived-pending-session",
            "user-1",
            CancellationToken.None);
        var wrongOwner = await DocumentStoreController.FindRecoveredRecordingEntryAsync(
            fixture.Db.DocumentEntries,
            "completed-session",
            "user-2",
            CancellationToken.None);

        recoveredCompleted.ShouldNotBeNull();
        recoveredCompleted.Id.ShouldBe(completedEntry.Id);
        recoveredArchivedPending.ShouldNotBeNull();
        recoveredArchivedPending.Id.ShouldBe(archivedPendingEntry.Id);
        wrongOwner.ShouldBeNull();
    }

    [Fact]
    public void RecoveredEntryFallback_ShouldGuardBothStatusAndCompletionEndpoints()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());

        // 两个调用点加一个方法定义：状态查询先找回确定性条目，完成请求再返回同一条目。
        source.Split(
                "FindRecoveredRecordingEntryAsync(",
                StringSplitOptions.None)
            .Length.ShouldBe(4);
    }

    [Fact]
    public void RecoveredEntryFallback_ShouldRevalidateCurrentStoreAccess()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());

        source.ShouldContain(
            "var (readableEntry, _, accessError) = await LoadReadableEntryAsync(");
        source.ShouldContain(
            "var (writableEntry, _, accessError) = await LoadWritableEntryAsync(");
    }

    [Fact]
    public void ActiveRecordingSessionEndpoints_ShouldRevalidateCurrentStoreAccess()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());
        var statusStart = source.IndexOf(
            "public async Task<IActionResult> GetRecordingUpload(",
            StringComparison.Ordinal);
        var liveStart = source.IndexOf(
            "public async Task LiveTranscription(",
            statusStart,
            StringComparison.Ordinal);
        var appendStart = source.IndexOf(
            "public async Task<IActionResult> AppendRecordingUploadChunk(",
            liveStart,
            StringComparison.Ordinal);
        var completeStart = source.IndexOf(
            "public async Task<IActionResult> CompleteRecordingUpload(",
            appendStart,
            StringComparison.Ordinal);
        var cancelStart = source.IndexOf(
            "public async Task<IActionResult> CancelRecordingUpload(",
            completeStart,
            StringComparison.Ordinal);

        statusStart.ShouldBeGreaterThanOrEqualTo(0);
        liveStart.ShouldBeGreaterThan(statusStart);
        appendStart.ShouldBeGreaterThan(liveStart);
        completeStart.ShouldBeGreaterThan(appendStart);
        cancelStart.ShouldBeGreaterThan(completeStart);

        source[statusStart..liveStart].ShouldContain(
            "await LoadReadableStoreAsync(session.StoreId, userId)");
        source[liveStart..appendStart].ShouldContain(
            "await LoadWritableStoreAsync(session.StoreId, userId)");
        source[appendStart..completeStart].ShouldContain(
            "await LoadWritableStoreAsync(session.StoreId, userId)");
        var completeBlock = source[completeStart..cancelStart];
        var accessCheck = completeBlock.IndexOf(
            "await LoadWritableStoreAsync(session.StoreId, userId)",
            StringComparison.Ordinal);
        var completedFastPath = completeBlock.IndexOf(
            "if (session.Status == DocumentRecordingUploadStatus.Completed",
            StringComparison.Ordinal);
        accessCheck.ShouldBeGreaterThanOrEqualTo(0);
        completedFastPath.ShouldBeGreaterThan(accessCheck);
    }

    [Fact]
    public async Task StalePendingLeaseCompensation_ShouldDeleteOnlyItsOwnEntryAndCount()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

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
    public async Task ArchiveClaim_ShouldMigrateCompatibleLegacyOwnerToCurrentDeployment()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        const string legacyOwner = "codex/example";
        const string currentOwner = "prd-agent:production::codex/example";
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(
            Session("legacy-owner-session", legacyOwner, DocumentRecordingArchiveStatus.Pending));

        var claimed = await DocumentRecordingArchiveWorker.ClaimOwnedArchiveSessionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            currentOwner,
            "current-lease",
            DateTime.UtcNow,
            CancellationToken.None,
            [currentOwner, legacyOwner]);

        claimed.ShouldNotBeNull();
        claimed!.OwnerInstanceId.ShouldBe(currentOwner);
        claimed.ArchiveLeaseId.ShouldBe("current-lease");
        (await fixture.Db.DocumentRecordingUploadSessions
                .Find(session => session.Id == claimed.Id)
                .SingleAsync())
            .OwnerInstanceId.ShouldBe(currentOwner);
    }

    [Fact]
    public async Task ArchiveClaim_AuthorizedProductionShouldAtomicallyAdoptHistoricalBranchOwner()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        const string historicalOwner = "codex/retired-preview";
        const string currentOwner = "prd-agent:production::main";
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(
            Session("historical-owner-session", historicalOwner, DocumentRecordingArchiveStatus.Pending));

        var cdsClaim = await DocumentRecordingArchiveWorker.ClaimOwnedArchiveSessionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            "prd-agent:cds::main",
            "cds-lease",
            DateTime.UtcNow,
            CancellationToken.None,
            ["prd-agent:cds::main"],
            adoptLegacyBranchOnlyOwners: false);
        cdsClaim.ShouldBeNull();

        var productionClaim = await DocumentRecordingArchiveWorker.ClaimOwnedArchiveSessionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            currentOwner,
            "production-lease",
            DateTime.UtcNow,
            CancellationToken.None,
            [currentOwner, "main"],
            adoptLegacyBranchOnlyOwners: true);

        productionClaim.ShouldNotBeNull();
        productionClaim!.OwnerInstanceId.ShouldBe(currentOwner);
        productionClaim.ArchiveLeaseId.ShouldBe("production-lease");
        (await fixture.Db.DocumentRecordingUploadSessions
                .Find(session => session.Id == productionClaim.Id)
                .SingleAsync())
            .OwnerInstanceId.ShouldBe(currentOwner);
    }

    [Fact]
    public async Task LegacyUnownedArchive_ShouldBeAdoptedByOnlyOneExplicitRequester()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

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
    public async Task StaleCompletedSideEffects_ShouldBeCompensatedOnlyAfterPendingWinnerCommits()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

        const string sessionId = "stale-completed-side-effects";
        var completedEntryId = DocumentStoreController.CompletedRecordingEntryId(sessionId);
        var pendingEntryId = DocumentStoreController.PendingRecordingEntryId(sessionId);
        var store = new DocumentStore
        {
            Id = "stale-completed-store",
            Name = "旧完成副作用补偿测试",
            OwnerId = "user-1",
            DocumentCount = 1,
        };
        var completedEntry = new DocumentEntry
        {
            Id = completedEntryId,
            StoreId = store.Id,
            Title = "stale-completed.webm",
            CreatedBy = "user-1",
        };
        var completedAttachment = new Attachment
        {
            AttachmentId = DocumentStoreController.CompletedRecordingAttachmentId(sessionId),
            FileName = "stale-completed.webm",
            Url = "https://assets.invalid/stale-completed.webm",
        };
        var session = Session(sessionId, "main", DocumentRecordingArchiveStatus.Completed);
        session.Status = DocumentRecordingUploadStatus.Completing;
        session.CompletionLeaseId = "new-owner-still-working";

        await fixture.Db.DocumentStores.InsertOneAsync(store);
        await fixture.Db.DocumentStores.UpdateOneAsync(
            s => s.Id == store.Id,
            Builders<DocumentStore>.Update.Set(
                DocumentStoreController.RecordingCountedEntryIdsField,
                new[] { completedEntryId }));
        await fixture.Db.DocumentEntries.InsertOneAsync(completedEntry);
        await fixture.Db.Attachments.InsertOneAsync(completedAttachment);
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);

        await DocumentStoreController.CompensateStaleCompletedRecordingEntryAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            fixture.Db.DocumentEntries,
            fixture.Db.Attachments,
            fixture.Db.DocumentStores,
            store.Id,
            sessionId,
            session.UserId,
            completedEntryId,
            CancellationToken.None);
        (await fixture.Db.DocumentEntries.Find(e => e.Id == completedEntryId).FirstOrDefaultAsync())
            .ShouldNotBeNull();

        await fixture.Db.DocumentRecordingUploadSessions.UpdateOneAsync(
            s => s.Id == sessionId,
            Builders<DocumentRecordingUploadSession>.Update
                .Set(s => s.Status, DocumentRecordingUploadStatus.Completed)
                .Set(s => s.EntryId, pendingEntryId)
                .Unset(s => s.CompletionLeaseId));
        await DocumentStoreController.CompensateStaleCompletedRecordingEntryAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            fixture.Db.DocumentEntries,
            fixture.Db.Attachments,
            fixture.Db.DocumentStores,
            store.Id,
            sessionId,
            session.UserId,
            completedEntryId,
            CancellationToken.None);

        (await fixture.Db.DocumentEntries.Find(e => e.Id == completedEntryId).FirstOrDefaultAsync())
            .ShouldBeNull();
        (await fixture.Db.Attachments.Find(
                a => a.AttachmentId == completedAttachment.AttachmentId)
            .FirstOrDefaultAsync()).ShouldBeNull();
        (await fixture.Db.DocumentStores.Find(s => s.Id == store.Id).SingleAsync())
            .DocumentCount.ShouldBe(0);
    }

    [Fact]
    public async Task StaleCompletedSideEffects_WithoutCountTokenShouldPreserveOtherEntryCount()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

        const string sessionId = "stale-completed-without-count";
        var completedEntryId = DocumentStoreController.CompletedRecordingEntryId(sessionId);
        var store = new DocumentStore
        {
            Id = "stale-completed-without-count-store",
            Name = "未记账旧完成副作用测试",
            OwnerId = "user-1",
            DocumentCount = 3,
        };
        var session = Session(sessionId, "main", DocumentRecordingArchiveStatus.Completed);
        session.Status = DocumentRecordingUploadStatus.Completed;
        session.EntryId = DocumentStoreController.PendingRecordingEntryId(sessionId);

        await fixture.Db.DocumentStores.InsertOneAsync(store);
        await fixture.Db.DocumentEntries.InsertOneAsync(new DocumentEntry
        {
            Id = completedEntryId,
            StoreId = store.Id,
            Title = "uncounted-stale-completed.webm",
            CreatedBy = session.UserId,
        });
        await fixture.Db.Attachments.InsertOneAsync(new Attachment
        {
            AttachmentId = DocumentStoreController.CompletedRecordingAttachmentId(sessionId),
            FileName = "uncounted-stale-completed.webm",
            Url = "https://assets.invalid/uncounted-stale-completed.webm",
        });
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);

        await DocumentStoreController.CompensateStaleCompletedRecordingEntryAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            fixture.Db.DocumentEntries,
            fixture.Db.Attachments,
            fixture.Db.DocumentStores,
            store.Id,
            sessionId,
            session.UserId,
            completedEntryId,
            CancellationToken.None);

        (await fixture.Db.DocumentStores.Find(s => s.Id == store.Id).SingleAsync())
            .DocumentCount.ShouldBe(3);
    }

    [Fact]
    public async Task RecordingEntryCount_ShouldApplyExactlyOnceAcrossRetries()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

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
    public void SuccessfulArchive_ShouldFenceSideEffectsAndCommitBeforeDeletingPendingWinner()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());
        var storageSuccess = source.IndexOf(
            "var stored = await CreateUploadedDocumentEntryAsync(",
            source.IndexOf("recordingAsset = await SaveUploadedAssetAsync(", StringComparison.Ordinal),
            StringComparison.Ordinal);
        storageSuccess.ShouldBeGreaterThanOrEqualTo(0);
        var leaseFence = source.LastIndexOf(
            "if (!await RefreshRecordingCompletionLeaseAsync(",
            storageSuccess,
            StringComparison.Ordinal);
        leaseFence.ShouldBeGreaterThanOrEqualTo(0);
        leaseFence.ShouldBeLessThan(storageSuccess);

        var finalizeStart = source.IndexOf(
            "private async Task<bool> FinalizeCompletedRecordingAsync(",
            StringComparison.Ordinal);
        var finalizeEnd = source.IndexOf(
            "internal static async Task CompensateStaleCompletedRecordingEntryAsync(",
            finalizeStart,
            StringComparison.Ordinal);
        finalizeEnd.ShouldBeGreaterThan(finalizeStart);
        var finalizeBlock = source[finalizeStart..finalizeEnd];
        var terminalWrite = finalizeBlock.IndexOf(
            "var completed = await _db.DocumentRecordingUploadSessions.UpdateOneAsync(",
            StringComparison.Ordinal);
        var pendingDelete = finalizeBlock.IndexOf(
            "var pendingDeleted = await _db.DocumentEntries.DeleteOneAsync(",
            StringComparison.Ordinal);
        var staleCompensation = finalizeBlock.IndexOf(
            "await CompensateStaleCompletedRecordingEntryAsync(",
            StringComparison.Ordinal);

        terminalWrite.ShouldBeGreaterThanOrEqualTo(0);
        pendingDelete.ShouldBeGreaterThan(terminalWrite);
        staleCompensation.ShouldBeGreaterThan(terminalWrite);
    }

    [Fact]
    public void NormalArchive_ShouldPersistLateTranscriptFromBothRaceOrderings()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());
        var finalizeStart = source.IndexOf(
            "private async Task<bool> FinalizeCompletedRecordingAsync(",
            StringComparison.Ordinal);
        var finalizeEnd = source.IndexOf(
            "internal static async Task<bool> PersistCompletedLiveTranscriptAsync(",
            finalizeStart,
            StringComparison.Ordinal);
        var finalizeBlock = source[finalizeStart..finalizeEnd];
        var terminalWrite = finalizeBlock.IndexOf(
            "var completed = await _db.DocumentRecordingUploadSessions.UpdateOneAsync(",
            StringComparison.Ordinal);
        var transcriptWriteBeforeTerminal = finalizeBlock.IndexOf(
            "await PersistCompletedLiveTranscriptAsync(",
            StringComparison.Ordinal);
        var transcriptWriteAfterTerminal = finalizeBlock.IndexOf(
            "await PersistCompletedLiveTranscriptAsync(",
            terminalWrite,
            StringComparison.Ordinal);

        terminalWrite.ShouldBeGreaterThanOrEqualTo(0);
        transcriptWriteBeforeTerminal.ShouldBeGreaterThanOrEqualTo(0);
        transcriptWriteBeforeTerminal.ShouldBeLessThan(terminalWrite);
        transcriptWriteAfterTerminal.ShouldBeGreaterThan(terminalWrite);
    }

    [Fact]
    public async Task PersistCompletedLiveTranscript_ShouldIndexLateNormalArchiveTranscript()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

        var entry = new DocumentEntry
        {
            Id = "normal-entry-late-live",
            StoreId = "store-1",
            Title = "recording.webm",
            Metadata = new Dictionary<string, string>
            {
                ["audioArchiveStatus"] = DocumentRecordingArchiveStatus.Completed,
                [DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey] = "true",
            },
        };
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        var transcript = new string('晚', 2101);
        var session = new DocumentRecordingUploadSession
        {
            Id = "normal-session-late-live",
            LiveTranscriptStatus = DocumentLiveTranscriptStatus.Completed,
            LiveTranscript = transcript,
            LiveTranscriptProvider = "provider-1",
            LiveTranscriptModel = "model-1",
        };

        (await DocumentStoreController.PersistCompletedLiveTranscriptAsync(
                fixture.Db.DocumentEntries,
                entry,
                session,
                CancellationToken.None))
            .ShouldBeTrue();

        var updated = await fixture.Db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync();
        updated.Summary.ShouldBe(transcript[..200]);
        updated.ContentIndex.ShouldBe(transcript[..2000]);
        updated.Metadata["liveTranscript"].ShouldBe(transcript);
        updated.Metadata["liveTranscriptStatus"].ShouldBe(DocumentLiveTranscriptStatus.Completed);
        updated.Metadata["liveTranscriptProvider"].ShouldBe("provider-1");
        updated.Metadata["liveTranscriptModel"].ShouldBe("model-1");
        updated.Metadata["audioArchiveStatus"].ShouldBe(DocumentRecordingArchiveStatus.Completed);
        updated.Metadata[DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey]
            .ShouldBe("true");
        updated.LastChangedAt.ShouldNotBeNull();
    }

    [Fact]
    public async Task PersistCompletedLiveTranscript_ShouldNotDowngradeCalibratedContent()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        var calibratedAt = new DateTime(2026, 7, 29, 8, 0, 0, DateTimeKind.Utc);
        var entry = new DocumentEntry
        {
            Id = "calibrated-entry-late-live",
            StoreId = "store-1",
            Title = "recording.webm",
            DocumentId = "full-audio-document",
            Summary = "完整音频校准摘要",
            ContentIndex = "完整音频校准正文索引",
            LastChangedAt = calibratedAt,
            Metadata = new Dictionary<string, string>
            {
                ["generated_kind"] = "transcribe",
                [DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey] = "true",
            },
        };
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        // 模拟 /complete 在批量 ASR 写入前读到的旧快照；数据库当前文档已经完成校准。
        var staleEntrySnapshot = new DocumentEntry
        {
            Id = entry.Id,
            StoreId = entry.StoreId,
            Title = entry.Title,
            Summary = "旧实时预览",
            ContentIndex = "旧实时预览",
            Metadata = new Dictionary<string, string>
            {
                [DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey] = "true",
            },
        };
        var session = new DocumentRecordingUploadSession
        {
            Id = "calibrated-session-late-live",
            LiveTranscriptStatus = DocumentLiveTranscriptStatus.Completed,
            LiveTranscript = "晚到但可能不完整的实时原文",
            LiveTranscriptProvider = "provider-1",
            LiveTranscriptModel = "model-1",
        };

        (await DocumentStoreController.PersistCompletedLiveTranscriptAsync(
                fixture.Db.DocumentEntries,
                staleEntrySnapshot,
                session,
                CancellationToken.None))
            .ShouldBeTrue();

        var updated = await fixture.Db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync();
        updated.DocumentId.ShouldBe(entry.DocumentId);
        updated.Summary.ShouldBe(entry.Summary);
        updated.ContentIndex.ShouldBe(entry.ContentIndex);
        updated.Metadata["generated_kind"].ShouldBe("transcribe");
        updated.Metadata["liveTranscript"].ShouldBe(session.LiveTranscript);
        updated.Metadata["liveTranscriptStatus"]
            .ShouldBe(DocumentLiveTranscriptStatus.Completed);
        updated.Metadata[DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey]
            .ShouldBe("true");
        updated.LastChangedAt.ShouldNotBeNull();
        updated.LastChangedAt.Value.ShouldBeGreaterThan(calibratedAt);
    }

    [Fact]
    public async Task InterruptedCompletedEntryRecovery_ShouldRestoreMissingCountExactlyOnce()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

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
    public async Task ExpiredRecordingCleanupClaim_ShouldBeMutuallyExclusiveWithCompletion()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        var now = DateTime.UtcNow;
        var completionFirst = new DocumentRecordingUploadSession
        {
            Id = "cleanup-race-completion-first",
            StoreId = "store-1",
            UserId = "user-1",
            Status = DocumentRecordingUploadStatus.Uploading,
            ExpiresAt = now.AddMinutes(-1),
            UpdatedAt = now.AddHours(-1),
        };
        var cleanupFirst = new DocumentRecordingUploadSession
        {
            Id = "cleanup-race-cleanup-first",
            StoreId = "store-1",
            UserId = "user-1",
            Status = DocumentRecordingUploadStatus.Uploading,
            ExpiresAt = now.AddMinutes(-1),
            UpdatedAt = now.AddHours(-1),
        };
        var pendingOutbox = new DocumentRecordingUploadSession
        {
            Id = "cleanup-race-pending-outbox",
            StoreId = "store-1",
            UserId = "user-1",
            Status = DocumentRecordingUploadStatus.Uploading,
            DeferredTranscriptionRunPending = true,
            ExpiresAt = now.AddMinutes(-1),
            UpdatedAt = now.AddHours(-1),
        };
        var staleCleanupLease = new DocumentRecordingUploadSession
        {
            Id = "cleanup-race-stale-cleanup-lease",
            StoreId = "store-1",
            UserId = "user-1",
            Status = DocumentRecordingUploadStatus.Cancelled,
            CleanupLeaseId = "abandoned-cleanup",
            ExpiresAt = now.AddMinutes(-1),
            UpdatedAt = now.AddMinutes(-11),
        };
        var freshCleanupLease = new DocumentRecordingUploadSession
        {
            Id = "cleanup-race-fresh-cleanup-lease",
            StoreId = "store-1",
            UserId = "user-1",
            Status = DocumentRecordingUploadStatus.Cancelled,
            CleanupLeaseId = "active-cleanup",
            ExpiresAt = now.AddMinutes(-1),
            UpdatedAt = now.AddMinutes(-9),
        };
        var notExpired = new DocumentRecordingUploadSession
        {
            Id = "cleanup-race-not-expired",
            StoreId = "store-1",
            UserId = "user-1",
            Status = DocumentRecordingUploadStatus.Uploading,
            ExpiresAt = now.AddMinutes(1),
            UpdatedAt = now.AddHours(-1),
        };
        var sessions = new[]
        {
            completionFirst,
            cleanupFirst,
            pendingOutbox,
            staleCleanupLease,
            freshCleanupLease,
            notExpired,
        };
        await fixture.Db.DocumentRecordingUploadSessions.InsertManyAsync(
            sessions);
        await fixture.Db.DocumentRecordingUploadChunks.InsertManyAsync(
            sessions
                .Select(session => Chunk(session.Id, 0, [1, 2])));

        (await DocumentStoreController.ClaimRecordingCompletionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            completionFirst.Id,
            completionFirst.UserId,
            "completion-lease",
            now,
            CancellationToken.None)).ShouldNotBeNull();

        var cleanupClaim = await DocumentStoreController.ClaimExpiredRecordingUploadsAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            now,
            CancellationToken.None);
        cleanupClaim.LeaseId.ShouldNotBeNullOrWhiteSpace();
        cleanupClaim.Sessions.Select(session => session.Id)
            .ShouldBe([cleanupFirst.Id, staleCleanupLease.Id], ignoreOrder: true);
        (await DocumentStoreController.ClaimExpiredRecordingUploadsAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            now,
            CancellationToken.None)).Sessions.ShouldBeEmpty();

        (await DocumentStoreController.ClaimRecordingCompletionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            cleanupFirst.Id,
            cleanupFirst.UserId,
            "late-completion-lease",
            now,
            CancellationToken.None)).ShouldBeNull();

        var claimedIds = cleanupClaim.Sessions.Select(session => session.Id).ToArray();
        await DocumentStoreController.CleanupExpiredRecordingUploadsAsync(
            claimedIds,
            ids => fixture.Db.DocumentRecordingUploadChunks.DeleteManyAsync(
                chunk => ids.Contains(chunk.SessionId)),
            ids => fixture.Db.DocumentRecordingUploadSessions.DeleteManyAsync(
                session => ids.Contains(session.Id)
                           && session.CleanupLeaseId == cleanupClaim.LeaseId
                           && session.Status == DocumentRecordingUploadStatus.Cancelled));

        (await fixture.Db.DocumentRecordingUploadSessions.CountDocumentsAsync(
            session => session.Id == cleanupFirst.Id)).ShouldBe(0);
        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            chunk => chunk.SessionId == cleanupFirst.Id)).ShouldBe(0);
        (await fixture.Db.DocumentRecordingUploadSessions.CountDocumentsAsync(
            session => session.Id == staleCleanupLease.Id)).ShouldBe(0);
        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            chunk => chunk.SessionId == staleCleanupLease.Id)).ShouldBe(0);
        (await fixture.Db.DocumentRecordingUploadSessions.CountDocumentsAsync(
            session => session.Id == completionFirst.Id)).ShouldBe(1);
        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            chunk => chunk.SessionId == completionFirst.Id)).ShouldBe(1);
        (await fixture.Db.DocumentRecordingUploadSessions.CountDocumentsAsync(
            session => session.Id == pendingOutbox.Id)).ShouldBe(1);
        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            chunk => chunk.SessionId == pendingOutbox.Id)).ShouldBe(1);
        foreach (var protectedSession in new[] { freshCleanupLease, notExpired })
        {
            (await fixture.Db.DocumentRecordingUploadSessions.CountDocumentsAsync(
                session => session.Id == protectedSession.Id)).ShouldBe(1);
            (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
                chunk => chunk.SessionId == protectedSession.Id)).ShouldBe(1);
        }
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
        run.Phase.ShouldBe("等待完整录音转录");
    }

    [Fact]
    public async Task EnsureDeferredTranscriptionRun_ShouldQueueBeforeArchiveAndRemainIdempotent()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

        var session = new DocumentRecordingUploadSession
        {
            Id = "session-immediate-transcribe",
            StoreId = "store-1",
            UserId = "user-1",
            LiveTranscriptStatus = DocumentLiveTranscriptStatus.Degraded,
            ArchiveStatus = DocumentRecordingArchiveStatus.Pending,
        };

        var first = await DocumentRecordingArchiveWorker.EnsureDeferredTranscriptionRunAsync(
            fixture.Db.DocumentStoreAgentRuns,
            session,
            "entry-1",
            "instance-1",
            entryRequiresDeferredTranscription: true,
            CancellationToken.None);
        var second = await DocumentRecordingArchiveWorker.EnsureDeferredTranscriptionRunAsync(
            fixture.Db.DocumentStoreAgentRuns,
            session,
            "entry-1",
            "instance-1",
            entryRequiresDeferredTranscription: true,
            CancellationToken.None);

        first.ShouldNotBeNull();
        second.ShouldNotBeNull();
        second!.Id.ShouldBe(first!.Id);
        (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(
            run => run.Id == first.Id)).ShouldBe(1);
    }

    [Theory]
    [InlineData(DocumentStoreRunStatus.Failed)]
    [InlineData(DocumentStoreRunStatus.Cancelled)]
    public async Task EnsureDeferredTranscriptionRun_ShouldNotReplayTerminalRunWithoutRetrySchedule(
        string terminalStatus)
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

        var session = new DocumentRecordingUploadSession
        {
            Id = $"session-retry-{terminalStatus}",
            StoreId = "store-1",
            UserId = "user-1",
            LiveTranscriptStatus = DocumentLiveTranscriptStatus.Degraded,
            ArchiveStatus = DocumentRecordingArchiveStatus.Pending,
        };
        var runId = DocumentRecordingArchiveWorker.DeferredTranscriptionRunId(session.Id);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(new DocumentStoreAgentRun
        {
            Id = runId,
            Kind = DocumentStoreAgentRunKind.Transcribe,
            SourceEntryId = "entry-1",
            StoreId = session.StoreId,
            UserId = session.UserId,
            OwnerInstanceId = "old-instance",
            Status = terminalStatus,
            Phase = "失败",
            Progress = 73,
            ErrorMessage = "服务重启，任务被中断",
            StartedAt = DateTime.UtcNow.AddMinutes(-2),
            EndedAt = DateTime.UtcNow.AddMinutes(-1),
        });

        var existing = await DocumentRecordingArchiveWorker.EnsureDeferredTranscriptionRunAsync(
            fixture.Db.DocumentStoreAgentRuns,
            session,
            "entry-1",
            "new-instance",
            entryRequiresDeferredTranscription: true,
            CancellationToken.None);

        existing.ShouldNotBeNull();
        existing!.Id.ShouldBe(runId);
        existing.Status.ShouldBe(terminalStatus);
        existing.Phase.ShouldBe("失败");
        existing.Progress.ShouldBe(73);
        existing.ErrorMessage.ShouldBe("服务重启，任务被中断");
        existing.StartedAt.ShouldNotBeNull();
        existing.EndedAt.ShouldNotBeNull();
        existing.OwnerInstanceId.ShouldBe("old-instance");
        (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(
            run => run.Id == runId)).ShouldBe(1);
    }

    [Theory]
    [InlineData(DocumentStoreRunStatus.Failed)]
    [InlineData(DocumentStoreRunStatus.Cancelled)]
    public async Task TerminalDeferredTranscriptionRun_ShouldClosePendingOutbox(
        string terminalStatus)
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        var now = DateTime.UtcNow;
        var session = new DocumentRecordingUploadSession
        {
            Id = $"session-terminal-close-{terminalStatus}",
            StoreId = "store-1",
            UserId = "user-1",
            OwnerInstanceId = "instance-1",
            Status = DocumentRecordingUploadStatus.Completed,
            ArchiveStatus = DocumentRecordingArchiveStatus.Completed,
            EntryId = "entry-1",
            DeferredTranscriptionRunPending = true,
            ExpiresAt = now.AddYears(10),
        };
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(new DocumentStoreAgentRun
        {
            Id = DocumentRecordingArchiveWorker.DeferredTranscriptionRunId(session.Id),
            Kind = DocumentStoreAgentRunKind.Transcribe,
            SourceEntryId = session.EntryId,
            StoreId = session.StoreId,
            UserId = session.UserId,
            OwnerInstanceId = session.OwnerInstanceId,
            Status = terminalStatus,
            AutomaticRetryCount = terminalStatus == DocumentStoreRunStatus.Failed
                ? DocumentRecordingArchiveWorker.MaxDeferredTranscriptionAutomaticRetries
                : 0,
        });

        var terminalRun = await DocumentRecordingArchiveWorker
            .EnsureAndAcknowledgeDeferredTranscriptionRunAsync(
                fixture.Db.DocumentRecordingUploadSessions,
                fixture.Db.DocumentStoreAgentRuns,
                session,
                session.EntryId,
                session.OwnerInstanceId,
                entryRequiresDeferredTranscription: true,
                CancellationToken.None);

        terminalRun.ShouldNotBeNull();
        terminalRun!.Status.ShouldBe(terminalStatus);
        var closed = await fixture.Db.DocumentRecordingUploadSessions
            .Find(candidate => candidate.Id == session.Id)
            .SingleAsync();
        closed.DeferredTranscriptionRunPending.ShouldBeFalse();
        closed.ExpiresAt.ShouldBeGreaterThan(now.AddHours(23));
        closed.ExpiresAt.ShouldBeLessThan(now.AddHours(25));
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(false, false)]
    public async Task ArchiveRetentionRefresh_ShouldFollowCurrentOutboxState(
        bool currentOutboxPending,
        bool observedOutboxPending)
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        var now = DateTime.UtcNow;
        var session = new DocumentRecordingUploadSession
        {
            Id = $"archive-retention-{currentOutboxPending}-{observedOutboxPending}",
            StoreId = "store-1",
            UserId = "user-1",
            Status = DocumentRecordingUploadStatus.Completed,
            EntryId = "entry-1",
            DeferredTranscriptionRunPending = currentOutboxPending,
            ExpiresAt = currentOutboxPending
                ? DocumentRecordingArchiveWorker.PendingOutboxExpiresAt(now)
                : DocumentRecordingArchiveWorker.CompletedSessionExpiresAt(now),
        };
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);

        (await DocumentRecordingArchiveWorker.RefreshArchiveRetentionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            observedOutboxPending,
            now.AddSeconds(1),
            CancellationToken.None)).ShouldBe(currentOutboxPending == observedOutboxPending);

        var retained = await fixture.Db.DocumentRecordingUploadSessions
            .Find(candidate => candidate.Id == session.Id)
            .SingleAsync();
        retained.DeferredTranscriptionRunPending.ShouldBe(currentOutboxPending);
        if (currentOutboxPending)
        {
            retained.ExpiresAt.ShouldBeGreaterThan(now.AddYears(9));
        }
        else
        {
            retained.ExpiresAt.ShouldBeGreaterThan(now.AddHours(23));
            retained.ExpiresAt.ShouldBeLessThan(now.AddHours(25));
        }
    }

    [Fact]
    public async Task ScheduledDeferredRetry_ShouldRequeueOnceAndIncrementPersistentCounter()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        var now = DateTime.UtcNow;
        var run = new DocumentStoreAgentRun
        {
            Id = DocumentRecordingArchiveWorker.DeferredTranscriptionRunId("session-due-retry"),
            Kind = DocumentStoreAgentRunKind.Transcribe,
            SourceEntryId = "entry-1",
            StoreId = "store-1",
            UserId = "user-1",
            OwnerInstanceId = "old-instance",
            Status = DocumentStoreRunStatus.Failed,
            Phase = "失败",
            Progress = 73,
            ErrorMessage = "服务重启，任务被中断",
            AutomaticRetryCount = 1,
            AutomaticRetryNextAt = now.AddSeconds(-1),
            AutomaticRetryReason =
                DocumentRecordingArchiveWorker.DeferredRetryReasonRestartInterrupted,
            StartedAt = now.AddMinutes(-2),
            EndedAt = now.AddMinutes(-1),
        };
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);

        var requeued = await DocumentRecordingArchiveWorker.TryRequeueDeferredTranscriptionRunAsync(
            fixture.Db.DocumentStoreAgentRuns,
            run,
            "new-instance",
            now,
            CancellationToken.None);

        requeued.ShouldNotBeNull();
        requeued!.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        requeued.AutomaticRetryCount.ShouldBe(2);
        requeued.AutomaticRetryNextAt.ShouldBeNull();
        requeued.AutomaticRetryReason.ShouldBe(
            DocumentRecordingArchiveWorker.DeferredRetryReasonRestartInterrupted);
        requeued.ErrorMessage.ShouldBeNull();
        requeued.StartedAt.ShouldBeNull();
        requeued.EndedAt.ShouldBeNull();
        requeued.OwnerInstanceId.ShouldBe("new-instance");
    }

    [Theory]
    [InlineData(DocumentStoreRunStatus.Failed, 0, 1)]
    [InlineData(DocumentStoreRunStatus.Failed, 3, -1)]
    [InlineData(DocumentStoreRunStatus.Cancelled, 0, -1)]
    public async Task DeferredRetry_ShouldRespectDueTimeLimitAndCancellation(
        string status,
        int retryCount,
        int nextAttemptMinutes)
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        var now = DateTime.UtcNow;
        var run = new DocumentStoreAgentRun
        {
            Id = DocumentRecordingArchiveWorker.DeferredTranscriptionRunId(
                $"session-policy-{status}-{retryCount}-{nextAttemptMinutes}"),
            Kind = DocumentStoreAgentRunKind.Transcribe,
            SourceEntryId = "entry-1",
            StoreId = "store-1",
            UserId = "user-1",
            Status = status,
            AutomaticRetryCount = retryCount,
            AutomaticRetryNextAt = now.AddMinutes(nextAttemptMinutes),
            AutomaticRetryReason =
                DocumentRecordingArchiveWorker.DeferredRetryReasonExecutionFailed,
        };
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(run);

        var unchanged = await DocumentRecordingArchiveWorker
            .TryRequeueDeferredTranscriptionRunAsync(
                fixture.Db.DocumentStoreAgentRuns,
                run,
                "instance-1",
                now,
                CancellationToken.None);

        unchanged.ShouldNotBeNull();
        unchanged!.Status.ShouldBe(status);
        unchanged.AutomaticRetryCount.ShouldBe(retryCount);
    }

    [Theory]
    [InlineData(0, 30)]
    [InlineData(1, 120)]
    [InlineData(2, 600)]
    [InlineData(100, 600)]
    public void DeferredRetryBackoff_ShouldIncreaseAndRemainBounded(
        int completedRetries,
        int expectedSeconds)
    {
        DocumentRecordingArchiveWorker
            .ComputeDeferredTranscriptionRetryBackoff(completedRetries)
            .ShouldBe(TimeSpan.FromSeconds(expectedSeconds));
    }

    [Theory]
    [InlineData("recording-archive-transcribe-session-1", 0, true)]
    [InlineData("recording-archive-transcribe-session-1", 2, true)]
    [InlineData("recording-archive-transcribe-session-1", 3, false)]
    [InlineData("manual-transcribe-run", 0, false)]
    public void AutomaticRetryBudget_ShouldRequireDeterministicRunBelowLimit(
        string runId,
        int retryCount,
        bool expected)
    {
        var run = new DocumentStoreAgentRun
        {
            Id = runId,
            AutomaticRetryCount = retryCount,
        };

        DocumentRecordingArchiveWorker
            .HasDeferredTranscriptionAutomaticRetryBudget(run)
            .ShouldBe(expected);
    }

    [Fact]
    public async Task AutomaticRetryBudgetFilter_ShouldTreatLegacyMissingCounterAsZero()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        var rawRuns = fixture.Db.Database.GetCollection<BsonDocument>(
            "document_store_agent_runs");
        await rawRuns.InsertManyAsync(
        [
            new BsonDocument
            {
                ["_id"] = "legacy-missing-counter",
                [nameof(DocumentStoreAgentRun.Status)] = DocumentStoreRunStatus.Running,
            },
            new BsonDocument
            {
                ["_id"] = "retry-budget-exhausted",
                [nameof(DocumentStoreAgentRun.Status)] = DocumentStoreRunStatus.Running,
                [nameof(DocumentStoreAgentRun.AutomaticRetryCount)] =
                    DocumentRecordingArchiveWorker.MaxDeferredTranscriptionAutomaticRetries,
            },
        ]);

        var matchingIds = await fixture.Db.DocumentStoreAgentRuns
            .Find(DocumentRecordingArchiveWorker
                .BuildDeferredTranscriptionAutomaticRetryBudgetFilter())
            .Project(run => run.Id)
            .ToListAsync();

        matchingIds.ShouldBe(["legacy-missing-counter"]);
    }

    [Fact]
    public async Task EnsureDeferredTranscriptionRun_ShouldNotRequeueCompletedRun()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

        var session = new DocumentRecordingUploadSession
        {
            Id = "session-already-done",
            StoreId = "store-1",
            UserId = "user-1",
            LiveTranscriptStatus = DocumentLiveTranscriptStatus.Degraded,
        };
        var runId = DocumentRecordingArchiveWorker.DeferredTranscriptionRunId(session.Id);
        await fixture.Db.DocumentStoreAgentRuns.InsertOneAsync(new DocumentStoreAgentRun
        {
            Id = runId,
            Kind = DocumentStoreAgentRunKind.Transcribe,
            SourceEntryId = "entry-1",
            StoreId = session.StoreId,
            UserId = session.UserId,
            OwnerInstanceId = "instance-1",
            Status = DocumentStoreRunStatus.Done,
            Phase = "完成",
            Progress = 100,
            EndedAt = DateTime.UtcNow,
        });

        var existing = await DocumentRecordingArchiveWorker.EnsureDeferredTranscriptionRunAsync(
            fixture.Db.DocumentStoreAgentRuns,
            session,
            "entry-1",
            "instance-1",
            entryRequiresDeferredTranscription: true,
            CancellationToken.None);

        existing.ShouldNotBeNull();
        existing!.Status.ShouldBe(DocumentStoreRunStatus.Done);
        existing.Progress.ShouldBe(100);
        existing.EndedAt.ShouldNotBeNull();
    }

    [Fact]
    public async Task PendingRecordingAudio_ShouldLoadCompleteMongoChunksWithoutAssetUrl()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

        var entry = new DocumentEntry
        {
            Id = "entry-mongo-audio",
            StoreId = "store-1",
            Title = "recording.m4a",
            ContentType = "audio/mp4",
            Metadata = new Dictionary<string, string>
            {
                ["recordingUploadSessionId"] = "session-mongo-audio",
                ["audioArchiveStatus"] = DocumentRecordingArchiveStatus.Pending,
            },
        };
        var session = new DocumentRecordingUploadSession
        {
            Id = "session-mongo-audio",
            EntryId = entry.Id,
            StoreId = entry.StoreId,
            UserId = "user-1",
            NextChunkIndex = 3,
            UploadedBytes = 6,
            Status = DocumentRecordingUploadStatus.Completed,
            ArchiveStatus = DocumentRecordingArchiveStatus.Pending,
        };
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);
        await fixture.Db.DocumentRecordingUploadChunks.InsertManyAsync(
        [
            Chunk(session.Id, 0, [1, 2]),
            Chunk(session.Id, 1, [3]),
            Chunk(session.Id, 2, [4, 5, 6]),
        ]);

        var audio = await SubtitleGenerationProcessor.LoadPendingRecordingAudioAsync(
            fixture.Db,
            entry,
            CancellationToken.None);

        audio.ShouldBe(new byte[] { 1, 2, 3, 4, 5, 6 });
    }

    [Fact]
    public void PendingArchiveCompletionPaths_ShouldQueueTranscriptionImmediately()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());

        // completed 快路径、并发完成快路径、崩溃恢复 pending、首次存储失败 pending。
        source.Split(
                "await EnsurePendingRecordingTranscriptionRunAsync(",
                StringSplitOptions.None)
            .Length.ShouldBe(5);
    }

    [Fact]
    public void CompletedArchivePath_ShouldQueueFullAudioCalibrationAfterLiveAsrDegrades()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());
        var methodStart = source.IndexOf(
            "private async Task<bool> FinalizeCompletedRecordingAsync(",
            StringComparison.Ordinal);
        var methodEnd = source.IndexOf(
            "internal static async Task CompensateStaleCompletedRecordingEntryAsync(",
            methodStart,
            StringComparison.Ordinal);

        methodStart.ShouldBeGreaterThanOrEqualTo(0);
        methodEnd.ShouldBeGreaterThan(methodStart);
        var method = source[methodStart..methodEnd];
        var intentIndex = method.IndexOf(
            ".PersistDeferredTranscriptionIntentAsync(",
            StringComparison.Ordinal);
        var terminalIndex = method.IndexOf(
            "var completed = await _db.DocumentRecordingUploadSessions.UpdateOneAsync(",
            StringComparison.Ordinal);
        var queueIndex = method.IndexOf(
            "await DocumentRecordingArchiveWorker.EnsureAndAcknowledgeDeferredTranscriptionRunAsync(",
            StringComparison.Ordinal);
        var rereadIndex = method.IndexOf(
            "var finalizedEntry = await _db.DocumentEntries",
            StringComparison.Ordinal);

        intentIndex.ShouldBeGreaterThanOrEqualTo(0);
        terminalIndex.ShouldBeGreaterThan(intentIndex);
        rereadIndex.ShouldBeGreaterThan(terminalIndex);
        queueIndex.ShouldBeGreaterThan(rereadIndex);
        method.ShouldContain("s => s.DeferredTranscriptionRunPending");
        method.ShouldContain(
            "DocumentRecordingArchiveWorker.RequiresDeferredTranscription(finalizedEntry)");
    }

    [Fact]
    public void InterruptedCompletedRecovery_ShouldReturnScheduledDeferredRunId()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());
        var recoveryStart = source.IndexOf(
            "var interruptedCompletedEntry = interruptedEntries.FirstOrDefault(",
            StringComparison.Ordinal);
        var nextRecoveryBranch = source.IndexOf(
            "var interruptedPendingEntry = interruptedEntries.FirstOrDefault(",
            recoveryStart,
            StringComparison.Ordinal);

        recoveryStart.ShouldBeGreaterThanOrEqualTo(0);
        nextRecoveryBranch.ShouldBeGreaterThan(recoveryStart);
        var completedRecovery = source[recoveryStart..nextRecoveryBranch];
        completedRecovery.ShouldContain("deferredTranscriptionRunId =");
        completedRecovery.ShouldContain(
            "DocumentRecordingArchiveWorker.DeferredTranscriptionRunId(sessionId)");
    }

    [Fact]
    public void ArchiveWorker_ShouldRecoverTranscriptionOutboxBeforeStorageArchive()
    {
        var source = File.ReadAllText(DocumentRecordingArchiveWorkerPath());
        var recoverIndex = source.IndexOf(
            "await RecoverDeferredTranscriptionRunsAsync(",
            StringComparison.Ordinal);
        var archiveClaimIndex = source.IndexOf(
            "await ClaimOwnedArchiveSessionAsync(",
            recoverIndex,
            StringComparison.Ordinal);

        recoverIndex.ShouldBeGreaterThanOrEqualTo(0);
        archiveClaimIndex.ShouldBeGreaterThan(recoverIndex);
    }

    [Fact]
    public void RecordingWorkerQueries_ShouldHaveExecutableIndexCatalogCoverage()
    {
        var catalog = File.ReadAllText(MongoDbIndexCatalogPath());

        catalog.ShouldContain("idx_recording_sessions_deferred_outbox");
        catalog.ShouldContain("idx_recording_sessions_archive_claim");
        catalog.ShouldContain("idx_recording_sessions_archive_expiry");
        catalog.ShouldContain("idx_recording_sessions_expired_cleanup_claim");
        catalog.ShouldContain("idx_recording_chunks_session_index");
    }

    [Fact]
    public void CompletedFastPaths_ShouldReconstructMissingDeterministicTranscriptionRun()
    {
        var source = File.ReadAllText(DocumentStoreControllerPath());
        var completeStart = source.IndexOf(
            "public async Task<IActionResult> CompleteRecordingUpload(",
            StringComparison.Ordinal);
        var finalizeStart = source.IndexOf(
            "private async Task<bool> FinalizeCompletedRecordingAsync(",
            completeStart,
            StringComparison.Ordinal);
        var completeBlock = source[completeStart..finalizeStart];

        completeBlock.Split(
                "EnsureCompletedRecordingTranscriptionRunAsync(",
                StringSplitOptions.None)
            .Length.ShouldBe(3);
        completeBlock.ShouldContain("deferredTranscriptionRunId = deferredRun?.Id");
    }

    [Theory]
    [InlineData(DocumentRecordingArchiveStatus.Completed)]
    [InlineData(DocumentRecordingArchiveStatus.Pending)]
    public async Task PersistedOutbox_ShouldRecoverInterruptedRunUntilTerminalSuccess(
        string archiveStatus)
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        var entry = new DocumentEntry
        {
            Id = "entry-terminal-gap",
            StoreId = "store-1",
            Title = "recording.m4a",
            Metadata = new Dictionary<string, string>
            {
                [DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey] = "true",
                [DocumentRecordingArchiveWorker.DeferredTranscriptionRunIdMetadataKey] =
                    "recording-archive-transcribe-session-terminal-gap",
            },
        };
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        var session = new DocumentRecordingUploadSession
        {
            Id = "session-terminal-gap",
            StoreId = "store-1",
            UserId = "user-1",
            OwnerInstanceId = "instance-1",
            Status = DocumentRecordingUploadStatus.Completed,
            ArchiveStatus = archiveStatus,
            LiveTranscriptStatus = DocumentLiveTranscriptStatus.Degraded,
            EntryId = entry.Id,
            DeferredTranscriptionRunPending = true,
        };
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);

        (await DocumentRecordingArchiveWorker.RecoverDeferredTranscriptionRunsAsync(
                fixture.Db.DocumentRecordingUploadSessions,
                fixture.Db.DocumentEntries,
                fixture.Db.DocumentStoreAgentRuns,
                "other-instance",
                CancellationToken.None))
            .ShouldBe(0);
        (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(_ => true)).ShouldBe(0);
        (await fixture.Db.DocumentRecordingUploadSessions
                .Find(candidate => candidate.Id == session.Id)
                .SingleAsync())
            .DeferredTranscriptionRunPending.ShouldBeTrue();

        (await DocumentRecordingArchiveWorker.RecoverDeferredTranscriptionRunsAsync(
                fixture.Db.DocumentRecordingUploadSessions,
                fixture.Db.DocumentEntries,
                fixture.Db.DocumentStoreAgentRuns,
                "instance-1",
                CancellationToken.None))
            .ShouldBe(1);

        var run = await fixture.Db.DocumentStoreAgentRuns
            .Find(candidate => candidate.Id ==
                "recording-archive-transcribe-session-terminal-gap")
            .SingleAsync();
        run.ShouldNotBeNull();
        run.Id.ShouldBe("recording-archive-transcribe-session-terminal-gap");
        run.SourceEntryId.ShouldBe(entry.Id);
        run.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(_ => true)).ShouldBe(1);
        (await fixture.Db.DocumentRecordingUploadSessions
                .Find(candidate => candidate.Id == session.Id)
                .SingleAsync())
            .DeferredTranscriptionRunPending.ShouldBeTrue();

        // 模拟任务已被领取后容器退出：Agent Worker 启动兜底会把 Running 标成 Failed。
        await fixture.Db.DocumentStoreAgentRuns.UpdateOneAsync(
            candidate => candidate.Id == run.Id,
            Builders<DocumentStoreAgentRun>.Update
                .Set(candidate => candidate.Status, DocumentStoreRunStatus.Running)
                .Set(candidate => candidate.OwnerInstanceId, "instance-1")
                .Set(candidate => candidate.StartedAt, DateTime.UtcNow));
        await fixture.Db.DocumentStoreAgentRuns.UpdateOneAsync(
            candidate => candidate.Id == run.Id,
            Builders<DocumentStoreAgentRun>.Update
                .Set(candidate => candidate.Status, DocumentStoreRunStatus.Failed)
                .Set(candidate => candidate.ErrorMessage, "服务重启，任务被中断")
                .Set(candidate => candidate.AutomaticRetryNextAt, DateTime.UtcNow.AddSeconds(-1))
                .Set(
                    candidate => candidate.AutomaticRetryReason,
                    DocumentRecordingArchiveWorker.DeferredRetryReasonRestartInterrupted)
                .Set(candidate => candidate.EndedAt, DateTime.UtcNow));

        (await DocumentRecordingArchiveWorker.RecoverDeferredTranscriptionRunsAsync(
                fixture.Db.DocumentRecordingUploadSessions,
                fixture.Db.DocumentEntries,
                fixture.Db.DocumentStoreAgentRuns,
                "instance-1",
                CancellationToken.None))
            .ShouldBe(1);
        run = await fixture.Db.DocumentStoreAgentRuns
            .Find(candidate => candidate.Id == run.Id)
            .SingleAsync();
        run.Status.ShouldBe(DocumentStoreRunStatus.Queued);
        run.AutomaticRetryCount.ShouldBe(1);
        run.AutomaticRetryNextAt.ShouldBeNull();
        run.ErrorMessage.ShouldBeNull();
        (await fixture.Db.DocumentRecordingUploadSessions
                .Find(candidate => candidate.Id == session.Id)
                .SingleAsync())
            .DeferredTranscriptionRunPending.ShouldBeTrue();

        // 只有确定性任务最终 Done 后，outbox 才能确认并停止恢复。
        await fixture.Db.DocumentStoreAgentRuns.UpdateOneAsync(
            candidate => candidate.Id == run.Id,
            Builders<DocumentStoreAgentRun>.Update
                .Set(candidate => candidate.Status, DocumentStoreRunStatus.Done)
                .Set(candidate => candidate.OutputEntryId, entry.Id)
                .Set(candidate => candidate.EndedAt, DateTime.UtcNow));
        (await DocumentRecordingArchiveWorker.RecoverDeferredTranscriptionRunsAsync(
                fixture.Db.DocumentRecordingUploadSessions,
                fixture.Db.DocumentEntries,
                fixture.Db.DocumentStoreAgentRuns,
                "instance-1",
                CancellationToken.None))
            .ShouldBe(1);
        (await fixture.Db.DocumentRecordingUploadSessions
                .Find(candidate => candidate.Id == session.Id)
                .SingleAsync())
            .DeferredTranscriptionRunPending.ShouldBeFalse();

        (await DocumentRecordingArchiveWorker.RecoverDeferredTranscriptionRunsAsync(
                fixture.Db.DocumentRecordingUploadSessions,
                fixture.Db.DocumentEntries,
                fixture.Db.DocumentStoreAgentRuns,
                "instance-1",
                CancellationToken.None))
            .ShouldBe(0);
        (await fixture.Db.DocumentStoreAgentRuns.CountDocumentsAsync(_ => true)).ShouldBe(1);
    }

    [Fact]
    public async Task DeferredOutboxAcknowledgement_ShouldRequireMatchingDeterministicRunAndEntry()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();
        var session = new DocumentRecordingUploadSession
        {
            Id = "session-ack",
            EntryId = "entry-ack",
            DeferredTranscriptionRunPending = true,
        };
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);

        (await DocumentRecordingArchiveWorker.AcknowledgeDeferredTranscriptionSuccessAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            "manual-transcribe-run",
            session.EntryId,
            CancellationToken.None)).ShouldBeFalse();
        (await DocumentRecordingArchiveWorker.AcknowledgeDeferredTranscriptionSuccessAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            DocumentRecordingArchiveWorker.DeferredTranscriptionRunId(session.Id),
            "other-entry",
            CancellationToken.None)).ShouldBeFalse();
        (await fixture.Db.DocumentRecordingUploadSessions.Find(s => s.Id == session.Id).SingleAsync())
            .DeferredTranscriptionRunPending.ShouldBeTrue();

        var acknowledgedAfter = DateTime.UtcNow;
        (await DocumentRecordingArchiveWorker.AcknowledgeDeferredTranscriptionSuccessAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            DocumentRecordingArchiveWorker.DeferredTranscriptionRunId(session.Id),
            session.EntryId,
            CancellationToken.None)).ShouldBeTrue();
        var acknowledged = await fixture.Db.DocumentRecordingUploadSessions
            .Find(s => s.Id == session.Id)
            .SingleAsync();
        acknowledged.DeferredTranscriptionRunPending.ShouldBeFalse();
        acknowledged.ExpiresAt.ShouldBeGreaterThan(acknowledgedAfter.AddHours(23));
        acknowledged.ExpiresAt.ShouldBeLessThan(acknowledgedAfter.AddHours(25));
    }

    [Fact]
    public void AgentWorker_ShouldAcknowledgeDeferredOutboxAfterMarkingRunDone()
    {
        var source = File.ReadAllText(DocumentStoreAgentWorkerPath());
        var doneIndex = source.IndexOf(
            ".Set(r => r.Status, DocumentStoreRunStatus.Done)",
            StringComparison.Ordinal);
        var acknowledgeIndex = source.IndexOf(
            ".AcknowledgeDeferredTranscriptionSuccessAsync(",
            doneIndex,
            StringComparison.Ordinal);

        doneIndex.ShouldBeGreaterThanOrEqualTo(0);
        acknowledgeIndex.ShouldBeGreaterThan(doneIndex);
    }

    [Fact]
    public void AgentWorker_ShouldKeepRecoverableFailuresQueuedUntilRetryBudgetIsExhausted()
    {
        var source = File.ReadAllText(DocumentStoreAgentWorkerPath());
        var catchStart = source.IndexOf(
            "var willRetry = DocumentRecordingArchiveWorker",
            StringComparison.Ordinal);
        var catchEnd = source.IndexOf(
            "finally\n        {",
            catchStart,
            StringComparison.Ordinal);

        catchStart.ShouldBeGreaterThanOrEqualTo(0);
        catchEnd.ShouldBeGreaterThan(catchStart);
        var failurePolicy = source[catchStart..catchEnd];
        failurePolicy.ShouldContain(
            ".Set(r => r.Status, DocumentStoreRunStatus.Queued)");
        failurePolicy.ShouldContain(".Inc(r => r.AutomaticRetryCount, 1)");
        failurePolicy.ShouldContain(".Set(r => r.ErrorMessage, null)");
        failurePolicy.ShouldContain(".Set(r => r.EndedAt, null)");
        failurePolicy.ShouldContain("\"phase\", new");
        failurePolicy.ShouldContain(
            ".Set(r => r.Status, DocumentStoreRunStatus.Failed)");
        failurePolicy.IndexOf(
                ".Set(r => r.Status, DocumentStoreRunStatus.Queued)",
                StringComparison.Ordinal)
            .ShouldBeLessThan(failurePolicy.IndexOf(
                ".Set(r => r.Status, DocumentStoreRunStatus.Failed)",
                StringComparison.Ordinal));
        source.ShouldContain(
            "Builders<DocumentStoreAgentRun>.Filter.Lte(\n                    r => r.AutomaticRetryNextAt,");
        failurePolicy.ShouldContain("CloseDeferredTranscriptionOutboxAsync(");
    }

    [Fact]
    public void ArchivedChunks_ShouldRemainAvailableUntilDeferredTranscriptionFinishes()
    {
        DocumentRecordingArchiveWorker.ShouldDeleteChunksAfterArchive(
                entryRequiresDeferredTranscription: false,
                deferredRun: null)
            .ShouldBeTrue();
        DocumentRecordingArchiveWorker.ShouldDeleteChunksAfterArchive(
                entryRequiresDeferredTranscription: true,
                deferredRun: null)
            .ShouldBeFalse();
        DocumentRecordingArchiveWorker.ShouldDeleteChunksAfterArchive(
                entryRequiresDeferredTranscription: true,
                new DocumentStoreAgentRun { Status = DocumentStoreRunStatus.Queued })
            .ShouldBeFalse();
        DocumentRecordingArchiveWorker.ShouldDeleteChunksAfterArchive(
                entryRequiresDeferredTranscription: true,
                new DocumentStoreAgentRun { Status = DocumentStoreRunStatus.Failed })
            .ShouldBeFalse();
        DocumentRecordingArchiveWorker.ShouldDeleteChunksAfterArchive(
                entryRequiresDeferredTranscription: true,
                new DocumentStoreAgentRun
                {
                    Status = DocumentStoreRunStatus.Cancelled,
                })
            .ShouldBeFalse();
        DocumentRecordingArchiveWorker.ShouldDeleteChunksAfterArchive(
                entryRequiresDeferredTranscription: true,
                new DocumentStoreAgentRun
                {
                    Id = DocumentRecordingArchiveWorker.DeferredTranscriptionRunId("terminal"),
                    Status = DocumentStoreRunStatus.Failed,
                    AutomaticRetryCount =
                        DocumentRecordingArchiveWorker.MaxDeferredTranscriptionAutomaticRetries,
                })
            .ShouldBeTrue();
        DocumentRecordingArchiveWorker.ShouldDeleteChunksAfterArchive(
                entryRequiresDeferredTranscription: true,
                new DocumentStoreAgentRun
                {
                    Status = DocumentStoreRunStatus.Running,
                    OutputEntryId = "entry-1",
                })
            .ShouldBeTrue();
        DocumentRecordingArchiveWorker.ShouldDeleteChunksAfterArchive(
                entryRequiresDeferredTranscription: true,
                new DocumentStoreAgentRun { Status = DocumentStoreRunStatus.Done })
            .ShouldBeTrue();
    }

    [Fact]
    public async Task SuccessfulTranscriptionCleanup_ShouldWaitForArchiveThenDeleteChunks()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

        const string sessionId = "session-transcription-cleanup";
        var session = new DocumentRecordingUploadSession
        {
            Id = sessionId,
            StoreId = "store-1",
            UserId = "user-1",
            EntryId = "entry-1",
            ArchiveStatus = DocumentRecordingArchiveStatus.Pending,
        };
        var entry = new DocumentEntry
        {
            Id = session.EntryId,
            StoreId = session.StoreId,
            Metadata = new Dictionary<string, string>
            {
                ["recordingUploadSessionId"] = sessionId,
            },
        };
        await fixture.Db.DocumentRecordingUploadSessions.InsertOneAsync(session);
        await fixture.Db.DocumentRecordingUploadChunks.InsertManyAsync(
        [
            Chunk(sessionId, 0, [1, 2]),
            Chunk(sessionId, 1, [3, 4]),
        ]);

        (await DocumentRecordingArchiveWorker.DeleteArchivedChunksAfterSuccessfulTranscriptionAsync(
                fixture.Db.DocumentRecordingUploadSessions,
                fixture.Db.DocumentRecordingUploadChunks,
                entry,
                CancellationToken.None))
            .ShouldBeFalse();
        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            chunk => chunk.SessionId == sessionId)).ShouldBe(2);

        await fixture.Db.DocumentRecordingUploadSessions.UpdateOneAsync(
            s => s.Id == sessionId,
            Builders<DocumentRecordingUploadSession>.Update.Set(
                s => s.ArchiveStatus,
                DocumentRecordingArchiveStatus.Completed));

        (await DocumentRecordingArchiveWorker.DeleteArchivedChunksAfterSuccessfulTranscriptionAsync(
                fixture.Db.DocumentRecordingUploadSessions,
                fixture.Db.DocumentRecordingUploadChunks,
                entry,
                CancellationToken.None))
            .ShouldBeTrue();
        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            chunk => chunk.SessionId == sessionId)).ShouldBe(0);
    }

    [Fact]
    public async Task ExpiredArchiveCleanup_ShouldRunWithoutNewRecordingAndKeepPendingAudio()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

        var now = DateTime.UtcNow;
        var sessions = new[]
        {
            new DocumentRecordingUploadSession
            {
                Id = "expired-archived",
                StoreId = "store-1",
                UserId = "user-1",
                ArchiveStatus = DocumentRecordingArchiveStatus.Completed,
                ExpiresAt = now.AddMinutes(-1),
            },
            new DocumentRecordingUploadSession
            {
                Id = "future-archived",
                StoreId = "store-1",
                UserId = "user-1",
                ArchiveStatus = DocumentRecordingArchiveStatus.Completed,
                ExpiresAt = now.AddMinutes(1),
            },
            new DocumentRecordingUploadSession
            {
                Id = "expired-pending",
                StoreId = "store-1",
                UserId = "user-1",
                ArchiveStatus = DocumentRecordingArchiveStatus.Pending,
                ExpiresAt = now.AddMinutes(-1),
            },
            new DocumentRecordingUploadSession
            {
                Id = "expired-archived-outbox",
                StoreId = "store-1",
                UserId = "user-1",
                ArchiveStatus = DocumentRecordingArchiveStatus.Completed,
                DeferredTranscriptionRunPending = true,
                ExpiresAt = now.AddMinutes(-1),
            },
        };
        await fixture.Db.DocumentRecordingUploadSessions.InsertManyAsync(sessions);
        await fixture.Db.DocumentRecordingUploadChunks.InsertManyAsync(
            sessions.Select(session => Chunk(session.Id, 0, [1, 2])));

        (await DocumentRecordingArchiveWorker.CleanupExpiredArchivedSessionsAsync(
                fixture.Db.DocumentRecordingUploadSessions,
                fixture.Db.DocumentRecordingUploadChunks,
                now,
                CancellationToken.None))
            .ShouldBe(1);

        (await fixture.Db.DocumentRecordingUploadSessions.CountDocumentsAsync(
            session => session.Id == "expired-archived")).ShouldBe(0);
        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            chunk => chunk.SessionId == "expired-archived")).ShouldBe(0);
        (await fixture.Db.DocumentRecordingUploadSessions.CountDocumentsAsync(
            session => session.Id == "future-archived")).ShouldBe(1);
        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            chunk => chunk.SessionId == "future-archived")).ShouldBe(1);
        (await fixture.Db.DocumentRecordingUploadSessions.CountDocumentsAsync(
            session => session.Id == "expired-pending")).ShouldBe(1);
        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            chunk => chunk.SessionId == "expired-pending")).ShouldBe(1);
        (await fixture.Db.DocumentRecordingUploadSessions.CountDocumentsAsync(
            session => session.Id == "expired-archived-outbox")).ShouldBe(1);
        (await fixture.Db.DocumentRecordingUploadChunks.CountDocumentsAsync(
            chunk => chunk.SessionId == "expired-archived-outbox")).ShouldBe(1);
    }

    [Fact]
    public void DeferredTranscriptionOutbox_ShouldRetainSessionUntilAcknowledged()
    {
        var now = new DateTime(2026, 7, 29, 0, 0, 0, DateTimeKind.Utc);

        DocumentRecordingArchiveWorker.PendingOutboxExpiresAt(now)
            .ShouldBe(now.AddYears(10));
        DocumentRecordingArchiveWorker.CompletedSessionExpiresAt(now)
            .ShouldBe(now.AddDays(1));
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

    [Fact]
    public async Task FinalizeArchivedEntry_ShouldPreserveCompletedDeferredTranscriptionContent()
    {
        await using var fixture = await RecordingMongoFixture.TryCreateAsync();

        var entry = new DocumentEntry
        {
            Id = "entry-archive-after-transcription",
            StoreId = "store-1",
            Title = "recording.webm",
            DocumentId = "document-generated-by-transcription",
            Summary = "完整录音转录生成的摘要",
            ContentIndex = "完整录音转录生成的正文索引",
            Metadata = new Dictionary<string, string>
            {
                ["audioArchiveStatus"] = DocumentRecordingArchiveStatus.Pending,
                ["generated_kind"] = "transcribe",
            },
        };
        await fixture.Db.DocumentEntries.InsertOneAsync(entry);
        var session = new DocumentRecordingUploadSession
        {
            Id = "session-archive-after-transcription",
            StoreId = "store-1",
            UserId = "user-1",
            LiveTranscriptStatus = DocumentLiveTranscriptStatus.Completed,
            LiveTranscript = "较短的实时转写原文",
            LiveTranscriptProvider = "provider-1",
            LiveTranscriptModel = "model-1",
        };

        await DocumentRecordingArchiveWorker.FinalizeArchivedEntryAsync(
            fixture.Db.DocumentEntries,
            entry.Id,
            "attachment-1",
            session,
            entryRequiresDeferredTranscription: true,
            cancellationToken: CancellationToken.None);

        var updated = await fixture.Db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync();
        updated.AttachmentId.ShouldBe("attachment-1");
        updated.DocumentId.ShouldBe(entry.DocumentId);
        updated.Summary.ShouldBe(entry.Summary);
        updated.ContentIndex.ShouldBe(entry.ContentIndex);
        updated.Metadata["audioArchiveStatus"].ShouldBe(DocumentRecordingArchiveStatus.Completed);
        updated.Metadata["liveTranscriptStatus"].ShouldBe(DocumentLiveTranscriptStatus.Completed);
        updated.Metadata["liveTranscript"].ShouldBe(session.LiveTranscript);
        updated.Metadata[DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey]
            .ShouldBe("true");
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

        public static async Task<RecordingMongoFixture> TryCreateAsync()
        {
            var configuredConnectionString =
                Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                ?? Environment.GetEnvironmentVariable("ADMIN_PUSH_TEST_MONGO_URI");
            var connectionString = configuredConnectionString ?? "mongodb://localhost:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(2);
            var client = new MongoClient(settings);
            try
            {
                await client.GetDatabase("admin").RunCommandAsync<MongoDB.Bson.BsonDocument>(
                    new MongoDB.Bson.BsonDocument("ping", 1));
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    "录音归档测试需要独立 MongoDB。CI 请设置 MONGODB_TEST_CONNECTION；" +
                    "本地默认使用 mongodb://localhost:27018。禁止在 MongoDB 不可达时静默通过。",
                    ex);
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

    private static string DocumentRecordingArchiveWorkerPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var path = Path.Combine(
                dir.FullName,
                "prd-api",
                "src",
                "PrdAgent.Api",
                "Services",
                "DocumentRecordingArchiveWorker.cs");
            if (File.Exists(path)) return path;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate DocumentRecordingArchiveWorker.cs from test base directory.");
    }

    private static string DocumentStoreAgentWorkerPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var path = Path.Combine(
                dir.FullName,
                "prd-api",
                "src",
                "PrdAgent.Api",
                "Services",
                "DocumentStoreAgentWorker.cs");
            if (File.Exists(path)) return path;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate DocumentStoreAgentWorker.cs from test base directory.");
    }

    private static string MongoDbIndexCatalogPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var path = Path.Combine(dir.FullName, "scripts", "mongodb-indexes.js");
            if (File.Exists(path)) return path;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate scripts/mongodb-indexes.js from test base directory.");
    }
}
