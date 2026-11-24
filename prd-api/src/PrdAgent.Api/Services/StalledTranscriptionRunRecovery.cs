using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>录音转录失联任务的服务端权威回收策略。</summary>
internal static class StalledTranscriptionRunRecovery
{
    internal const string FailureCode = "TRANSCRIPTION_RUN_STALLED";
    internal static readonly TimeSpan StaleAfter = TimeSpan.FromHours(1);

    internal static async Task<long> ReapAsync(
        IMongoCollection<DocumentStoreAgentRun> runs,
        string entryId,
        string userId,
        string? templateKey,
        string? customPrompt,
        string? styleContext,
        IReadOnlyCollection<string> compatibleOwnerIds,
        DateTime now,
        CancellationToken cancellationToken)
    {
        var stalledAt = now - StaleAfter;
        var runningStalledClock = Builders<DocumentStoreAgentRun>.Filter.And(
            Builders<DocumentStoreAgentRun>.Filter.Eq(
                r => r.Status,
                DocumentStoreRunStatus.Running),
            Builders<DocumentStoreAgentRun>.Filter.Or(
            Builders<DocumentStoreAgentRun>.Filter.Lt(r => r.HeartbeatAt, stalledAt),
            Builders<DocumentStoreAgentRun>.Filter.And(
                Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.HeartbeatAt, null),
                Builders<DocumentStoreAgentRun>.Filter.Lt(r => r.StartedAt, stalledAt)),
            Builders<DocumentStoreAgentRun>.Filter.And(
                Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.HeartbeatAt, null),
                Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.StartedAt, null),
                Builders<DocumentStoreAgentRun>.Filter.Lt(r => r.CreatedAt, stalledAt))));
        var queuedStalledClock = Builders<DocumentStoreAgentRun>.Filter.And(
            Builders<DocumentStoreAgentRun>.Filter.Eq(
                r => r.Status,
                DocumentStoreRunStatus.Queued),
            Builders<DocumentStoreAgentRun>.Filter.Or(
                Builders<DocumentStoreAgentRun>.Filter.And(
                    Builders<DocumentStoreAgentRun>.Filter.Ne(
                        r => r.AutomaticRetryNextAt,
                        null),
                    Builders<DocumentStoreAgentRun>.Filter.Lt(
                        r => r.AutomaticRetryNextAt,
                        stalledAt)),
                Builders<DocumentStoreAgentRun>.Filter.And(
                    Builders<DocumentStoreAgentRun>.Filter.Eq(
                        r => r.AutomaticRetryNextAt,
                        null),
                    Builders<DocumentStoreAgentRun>.Filter.Lt(r => r.CreatedAt, stalledAt))));
        var stalledClock = Builders<DocumentStoreAgentRun>.Filter.Or(
            runningStalledClock,
            queuedStalledClock);
        var reusableOwners = Builders<DocumentStoreAgentRun>.Filter.Or(
            Builders<DocumentStoreAgentRun>.Filter.In(r => r.OwnerInstanceId, compatibleOwnerIds),
            Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.OwnerInstanceId, (string?)null),
            Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.OwnerInstanceId, string.Empty));
        var filter = Builders<DocumentStoreAgentRun>.Filter.And(
            Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.SourceEntryId, entryId),
            Builders<DocumentStoreAgentRun>.Filter.Eq(
                r => r.Kind,
                DocumentStoreAgentRunKind.Transcribe),
            Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.UserId, userId),
            Builders<DocumentStoreAgentRun>.Filter.In(
                r => r.Status,
                new[] { DocumentStoreRunStatus.Queued, DocumentStoreRunStatus.Running }),
            Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.RestyleOfRunId, null),
            Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.TemplateKey, templateKey),
            Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.CustomPrompt, customPrompt),
            Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.StyleContext, styleContext),
            reusableOwners,
            stalledClock);

        var result = await runs.UpdateManyAsync(
            filter,
            Builders<DocumentStoreAgentRun>.Update
                .Set(r => r.Status, DocumentStoreRunStatus.Failed)
                .Set(r => r.Phase, "后台任务失联，等待手动重试")
                .Set(r => r.ErrorMessage, "后台转录超过一小时未报告状态。旧任务已终止，本次重试将创建新任务；录音仍然保留。")
                .Set(r => r.FailureCode, FailureCode)
                .Set(r => r.HeartbeatAt, null)
                .Set(r => r.EndedAt, now)
                .Set(r => r.AutomaticRetryNextAt, null)
                .Set(r => r.AutomaticRetryReason, null),
            cancellationToken: cancellationToken);
        return result.ModifiedCount;
    }
}
