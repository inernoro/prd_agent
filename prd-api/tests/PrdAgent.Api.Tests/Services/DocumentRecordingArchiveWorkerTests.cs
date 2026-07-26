using PrdAgent.Api.Services;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
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
        var second = await DocumentStoreController.ClaimRecordingCompletionAsync(
            fixture.Db.DocumentRecordingUploadSessions,
            session.Id,
            session.UserId,
            "new-lease",
            DateTime.UtcNow,
            CancellationToken.None);
        second.ShouldNotBeNull();

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
            "instance-1");

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
                "instance-1")
            .ShouldBeNull();
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
}
