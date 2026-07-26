using PrdAgent.Api.Services;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
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
}
