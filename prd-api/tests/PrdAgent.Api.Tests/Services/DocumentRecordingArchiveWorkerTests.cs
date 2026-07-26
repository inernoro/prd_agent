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
