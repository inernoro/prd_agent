using Microsoft.Extensions.Hosting;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 将对象存储故障期间已落 Mongo 的录音分片异步归档到正式资产存储。
/// 归档成功前不删除分片；部署实例归属、状态认领与租约令牌共同隔离并发执行者。
/// </summary>
public sealed class DocumentRecordingArchiveWorker : BackgroundService
{
    internal const string DeferredTranscriptionRequiredMetadataKey = "deferredTranscriptionRequired";
    internal const string DeferredTranscriptionRunIdMetadataKey = "deferredTranscriptionRunId";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan StaleLease = TimeSpan.FromMinutes(10);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<DocumentRecordingArchiveWorker> _logger;

    public DocumentRecordingArchiveWorker(
        IServiceScopeFactory scopeFactory,
        ILogger<DocumentRecordingArchiveWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[recording-archive] Worker started");
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ProcessOneAsync();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[recording-archive] Worker loop failed");
            }

            try
            {
                await Task.Delay(PollInterval, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    private async Task ProcessOneAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var storage = scope.ServiceProvider.GetRequiredService<IAssetStorage>();
        var instanceId = InstanceIdentity.Get(
            scope.ServiceProvider.GetRequiredService<IConfiguration>());
        var now = DateTime.UtcNow;

        await ReleaseStaleOwnedArchiveLeasesAsync(
            db.DocumentRecordingUploadSessions,
            instanceId,
            now,
            CancellationToken.None);

        var archiveLeaseId = Guid.NewGuid().ToString("N");
        var session = await ClaimOwnedArchiveSessionAsync(
            db.DocumentRecordingUploadSessions,
            instanceId,
            archiveLeaseId,
            now,
            CancellationToken.None);
        if (session == null)
            return;

        try
        {
            var entry = !string.IsNullOrWhiteSpace(session.EntryId)
                ? await db.DocumentEntries.Find(e => e.Id == session.EntryId).FirstOrDefaultAsync(CancellationToken.None)
                : null;
            if (entry == null)
            {
                // 用户已删除条目是永久状态，不是对象存储瞬时故障。先删分片再删会话，
                // 即使进程在两步之间退出，下一轮仍能完成清理，不会十年重试并占用 Mongo。
                await db.DocumentRecordingUploadChunks.DeleteManyAsync(
                    c => c.SessionId == session.Id,
                    cancellationToken: CancellationToken.None);
                await db.DocumentRecordingUploadSessions.DeleteOneAsync(
                    s => s.Id == session.Id
                         && s.OwnerInstanceId == instanceId
                         && s.ArchiveStatus == DocumentRecordingArchiveStatus.Archiving
                         && s.ArchiveLeaseId == archiveLeaseId,
                    cancellationToken: CancellationToken.None);
                _logger.LogInformation(
                    "[recording-archive] Removed orphaned archive session={SessionId} entry={EntryId}",
                    session.Id,
                    session.EntryId);
                return;
            }

            var chunks = await db.DocumentRecordingUploadChunks
                .Find(c => c.SessionId == session.Id)
                .SortBy(c => c.Index)
                .ToListAsync(CancellationToken.None);
            var bytes = AssembleChunks(chunks, session.NextChunkIndex, session.UploadedBytes);
            var stored = await storage.SaveAsync(
                bytes,
                session.MimeType,
                CancellationToken.None,
                domain: "prd-agent",
                type: "doc",
                fileName: session.FileName);

            // 归档期间实时中继可能刚好完成。回读最新会话，避免用认领时的旧快照
            // 误排一次完整文件 ASR，或漏写已经稳定完成的实时原文。
            var latestSession = await db.DocumentRecordingUploadSessions
                .Find(s => s.Id == session.Id
                           && s.OwnerInstanceId == instanceId
                           && s.ArchiveStatus == DocumentRecordingArchiveStatus.Archiving
                           && s.ArchiveLeaseId == archiveLeaseId)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (latestSession == null)
            {
                _logger.LogInformation(
                    "[recording-archive] Lease superseded session={SessionId} lease={LeaseId}",
                    session.Id,
                    archiveLeaseId);
                return;
            }

            var attachmentId = entry.AttachmentId;
            if (string.IsNullOrWhiteSpace(attachmentId))
            {
                // 固定 ID + upsert：Worker 若在“附件落库、条目回写”之间崩溃，
                // stale lease 重跑时不会再制造一条孤儿附件。
                attachmentId = $"recording-archive-{session.Id}";
                var attachment = new Attachment
                {
                    AttachmentId = attachmentId,
                    UploaderId = session.UserId,
                    FileName = session.FileName,
                    MimeType = session.MimeType,
                    Size = bytes.LongLength,
                    Url = stored.Url,
                    Type = AttachmentType.Document,
                    UploadedAt = DateTime.UtcNow,
                };
                await db.Attachments.ReplaceOneAsync(
                    a => a.AttachmentId == attachmentId,
                    attachment,
                    new ReplaceOptions { IsUpsert = true },
                    cancellationToken: CancellationToken.None);
            }

            // pending entry 创建后，实时中继仍可能晚一步写入最终原文。记住客户端当时
            // 是否已经拿到原文：若没有，即使现在原文已到，也仍需创建固定 ID 的转录 run，
            // 让前端轮询有终点并生成标准转录笔记。
            var entryRequiresDeferredTranscription = RequiresDeferredTranscription(entry);
            await FinalizeArchivedEntryAsync(
                db.DocumentEntries,
                entry.Id,
                attachmentId,
                latestSession,
                entryRequiresDeferredTranscription,
                CancellationToken.None);

            var deferredRun = await EnsureDeferredTranscriptionRunAsync(
                db.DocumentStoreAgentRuns,
                latestSession,
                entry.Id,
                instanceId,
                entryRequiresDeferredTranscription,
                CancellationToken.None);
            if (deferredRun != null)
            {
                _logger.LogInformation(
                    "[recording-archive] Deferred transcription ensured session={SessionId} run={RunId}",
                    session.Id,
                    deferredRun.Id);
            }

            var completed = await db.DocumentRecordingUploadSessions.UpdateOneAsync(
                s => s.Id == session.Id
                     && s.OwnerInstanceId == instanceId
                     && s.ArchiveStatus == DocumentRecordingArchiveStatus.Archiving
                     && s.ArchiveLeaseId == archiveLeaseId,
                Builders<DocumentRecordingUploadSession>.Update
                    .Set(s => s.ArchiveStatus, DocumentRecordingArchiveStatus.Completed)
                    .Unset(s => s.ArchiveLeaseId)
                    .Set(s => s.ArchiveUrl, stored.Url)
                    .Set(s => s.ArchiveError, null)
                    .Set(s => s.ArchiveNextAttemptAt, null)
                    .Set(s => s.UpdatedAt, DateTime.UtcNow)
                    .Set(s => s.ExpiresAt, DateTime.UtcNow.AddDays(1)),
                cancellationToken: CancellationToken.None);
            // 延迟转录可能已经开始读取 Mongo 分片。归档成功与转录读取并发时若立即
            // 删除分片，会在“Mongo 降级源 -> 正式附件”切换窗口制造一次假失败。
            // 需要延迟转录的会话保留分片到 ExpiresAt，由统一 TTL 清理路径回收；
            // 不需要延迟转录时才立即释放。
            if (completed.ModifiedCount == 1
                && ShouldDeleteChunksImmediatelyAfterArchive(entryRequiresDeferredTranscription))
            {
                await db.DocumentRecordingUploadChunks.DeleteManyAsync(
                    c => c.SessionId == session.Id,
                    cancellationToken: CancellationToken.None);
            }
            _logger.LogInformation(
                "[recording-archive] Archived session={SessionId} entry={EntryId} bytes={Bytes}",
                session.Id,
                entry.Id,
                bytes.LongLength);
        }
        catch (Exception ex)
        {
            var attempts = session.ArchiveAttempts + 1;
            var nextAttempt = DateTime.UtcNow.Add(ComputeBackoff(attempts));
            var error = ex.Message.Length > 300 ? ex.Message[..300] : ex.Message;
            await db.DocumentRecordingUploadSessions.UpdateOneAsync(
                s => s.Id == session.Id
                     && s.OwnerInstanceId == instanceId
                     && s.ArchiveStatus == DocumentRecordingArchiveStatus.Archiving
                     && s.ArchiveLeaseId == archiveLeaseId,
                Builders<DocumentRecordingUploadSession>.Update
                    .Set(s => s.ArchiveStatus, DocumentRecordingArchiveStatus.Pending)
                    .Unset(s => s.ArchiveLeaseId)
                    .Set(s => s.ArchiveAttempts, attempts)
                    .Set(s => s.ArchiveNextAttemptAt, nextAttempt)
                    .Set(s => s.ArchiveError, error)
                    .Set(s => s.UpdatedAt, DateTime.UtcNow)
                    .Set(s => s.ExpiresAt, DateTime.UtcNow.AddYears(10)),
                cancellationToken: CancellationToken.None);
            _logger.LogWarning(
                ex,
                "[recording-archive] Archive deferred session={SessionId} attempts={Attempts} next={NextAttempt}",
                session.Id,
                attempts,
                nextAttempt);
        }
    }

    internal static async Task<long> ReleaseStaleOwnedArchiveLeasesAsync(
        IMongoCollection<DocumentRecordingUploadSession> sessions,
        string instanceId,
        DateTime now,
        CancellationToken cancellationToken)
    {
        var released = await sessions.UpdateManyAsync(
            s => s.OwnerInstanceId == instanceId
                 && s.ArchiveStatus == DocumentRecordingArchiveStatus.Archiving
                 && s.UpdatedAt <= now.Subtract(StaleLease),
            Builders<DocumentRecordingUploadSession>.Update
                .Set(s => s.ArchiveStatus, DocumentRecordingArchiveStatus.Pending)
                .Unset(s => s.ArchiveLeaseId)
                .Set(s => s.ArchiveNextAttemptAt, now),
            cancellationToken: cancellationToken);
        return released.ModifiedCount;
    }

    internal static async Task<DocumentRecordingUploadSession?> ClaimOwnedArchiveSessionAsync(
        IMongoCollection<DocumentRecordingUploadSession> sessions,
        string instanceId,
        string archiveLeaseId,
        DateTime now,
        CancellationToken cancellationToken)
    {
        var dueFilter = Builders<DocumentRecordingUploadSession>.Filter.And(
            Builders<DocumentRecordingUploadSession>.Filter.Eq(s => s.OwnerInstanceId, instanceId),
            Builders<DocumentRecordingUploadSession>.Filter.Eq(
                s => s.ArchiveStatus,
                DocumentRecordingArchiveStatus.Pending),
            Builders<DocumentRecordingUploadSession>.Filter.Or(
                Builders<DocumentRecordingUploadSession>.Filter.Eq(s => s.ArchiveNextAttemptAt, null),
                Builders<DocumentRecordingUploadSession>.Filter.Lte(s => s.ArchiveNextAttemptAt, now)));
        return await sessions.FindOneAndUpdateAsync(
            dueFilter,
            Builders<DocumentRecordingUploadSession>.Update
                .Set(s => s.ArchiveStatus, DocumentRecordingArchiveStatus.Archiving)
                .Set(s => s.ArchiveLeaseId, archiveLeaseId)
                .Set(s => s.UpdatedAt, now),
            new FindOneAndUpdateOptions<DocumentRecordingUploadSession>
            {
                ReturnDocument = ReturnDocument.After,
                Sort = Builders<DocumentRecordingUploadSession>.Sort.Ascending(s => s.ArchiveNextAttemptAt),
            },
            cancellationToken);
    }

    internal static byte[] AssembleChunks(
        IReadOnlyList<DocumentRecordingUploadChunk> chunks,
        int expectedCount,
        long expectedBytes)
    {
        if (chunks.Count == 0 || expectedCount <= 0)
            throw new InvalidOperationException("录音归档分片数量不完整");
        if (expectedBytes <= 0 || expectedBytes > int.MaxValue)
            throw new InvalidOperationException("录音归档大小无效");

        var groups = chunks
            .GroupBy(chunk => chunk.Index)
            .OrderBy(group => group.Key)
            .ToArray();
        if (groups.Length != expectedCount)
            throw new InvalidOperationException("录音归档分片数量不完整");

        using var joined = new MemoryStream((int)expectedBytes);
        for (var index = 0; index < groups.Length; index++)
        {
            var group = groups[index];
            if (group.Key != index)
                throw new InvalidOperationException($"录音归档缺少第 {index} 个分片");
            var chunk = group.First();
            if (chunk.Data.LongLength != chunk.SizeBytes)
                throw new InvalidOperationException($"录音归档第 {index} 个分片大小无效");
            if (group.Skip(1).Any(duplicate =>
                    duplicate.SizeBytes != chunk.SizeBytes
                    || !duplicate.Data.AsSpan().SequenceEqual(chunk.Data)))
            {
                throw new InvalidOperationException($"录音归档第 {index} 个分片存在内容冲突");
            }
            joined.Write(chunk.Data);
        }
        if (joined.Length != expectedBytes)
            throw new InvalidOperationException("录音归档分片大小校验失败");
        return joined.ToArray();
    }

    internal static TimeSpan ComputeBackoff(int attempts)
    {
        var minutes = Math.Min(360, Math.Pow(2, Math.Clamp(attempts, 0, 8)));
        return TimeSpan.FromMinutes(minutes);
    }

    internal static DocumentStoreAgentRun? BuildDeferredTranscriptionRun(
        DocumentRecordingUploadSession session,
        string entryId,
        string ownerInstanceId,
        bool entryRequiresDeferredTranscription)
    {
        if (session.LiveTranscriptStatus == DocumentLiveTranscriptStatus.Completed
            && !string.IsNullOrWhiteSpace(session.LiveTranscript)
            && !entryRequiresDeferredTranscription)
        {
            return null;
        }

        return new DocumentStoreAgentRun
        {
            Id = DeferredTranscriptionRunId(session.Id),
            Kind = DocumentStoreAgentRunKind.Transcribe,
            SourceEntryId = entryId,
            StoreId = session.StoreId,
            UserId = session.UserId,
            OwnerInstanceId = ownerInstanceId,
            Status = DocumentStoreRunStatus.Queued,
            Phase = "等待完整录音转录",
        };
    }

    internal static async Task<DocumentStoreAgentRun?> EnsureDeferredTranscriptionRunAsync(
        IMongoCollection<DocumentStoreAgentRun> runs,
        DocumentRecordingUploadSession session,
        string entryId,
        string ownerInstanceId,
        bool entryRequiresDeferredTranscription,
        CancellationToken cancellationToken)
    {
        var run = BuildDeferredTranscriptionRun(
            session,
            entryId,
            ownerInstanceId,
            entryRequiresDeferredTranscription);
        if (run == null)
            return null;

        // 固定 run ID 让完成接口、归档 Worker、崩溃重试和用户手动重试共同收敛到
        // 同一个任务。pending entry 建立后即可排队，处理器会直接读取 Mongo 分片；
        // 不再把对象存储恢复当作转录的前置条件。
        try
        {
            await runs.InsertOneAsync(run, cancellationToken: cancellationToken);
            return run;
        }
        catch (MongoWriteException ex)
            when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 固定任务可能在容器重启或主动取消时进入终态。后续 /complete、归档重试
            // 或用户重试都代表再次提交同一份完整录音，应原子恢复为 queued；否则固定
            // ID 虽避免了重复任务，却会把一次可恢复失败永久固化。Done/Running/Queued
            // 保持幂等，不能重复执行已经完成或正在处理的任务。
            var retryableTerminalFilter = Builders<DocumentStoreAgentRun>.Filter.And(
                Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.Id, run.Id),
                Builders<DocumentStoreAgentRun>.Filter.In(
                    r => r.Status,
                    [DocumentStoreRunStatus.Failed, DocumentStoreRunStatus.Cancelled]));
            var requeued = await runs.FindOneAndUpdateAsync(
                retryableTerminalFilter,
                Builders<DocumentStoreAgentRun>.Update
                    .Set(r => r.Status, DocumentStoreRunStatus.Queued)
                    .Set(r => r.Phase, run.Phase)
                    .Set(r => r.Progress, 0)
                    .Set(r => r.ErrorMessage, null)
                    .Set(r => r.StartedAt, null)
                    .Set(r => r.EndedAt, null)
                    .Set(r => r.OwnerInstanceId, ownerInstanceId),
                new FindOneAndUpdateOptions<DocumentStoreAgentRun>
                {
                    ReturnDocument = ReturnDocument.After,
                },
                cancellationToken);
            return requeued
                   ?? await runs.Find(r => r.Id == run.Id).FirstOrDefaultAsync(cancellationToken);
        }
    }

    internal static string DeferredTranscriptionRunId(string sessionId)
        => $"recording-archive-transcribe-{sessionId}";

    internal static bool ShouldDeleteChunksImmediatelyAfterArchive(
        bool entryRequiresDeferredTranscription)
        => !entryRequiresDeferredTranscription;

    internal static string? DeferredTranscriptionRunIdForClient(
        bool archivePending,
        DocumentEntry entry,
        string sessionId)
        => archivePending && RequiresDeferredTranscription(entry)
            ? DeferredTranscriptionRunId(sessionId)
            : null;

    internal static bool HasCompletedLiveTranscript(DocumentEntry entry)
        => entry.Metadata != null
           && entry.Metadata.GetValueOrDefault("liveTranscriptStatus")
               == DocumentLiveTranscriptStatus.Completed
           && !string.IsNullOrWhiteSpace(entry.Metadata.GetValueOrDefault("liveTranscript"));

    internal static bool RequiresDeferredTranscription(DocumentEntry entry)
        => entry.Metadata?.GetValueOrDefault(DeferredTranscriptionRequiredMetadataKey) == "true"
           || !HasCompletedLiveTranscript(entry);

    internal static async Task FinalizeArchivedEntryAsync(
        IMongoCollection<DocumentEntry> entries,
        string entryId,
        string attachmentId,
        DocumentRecordingUploadSession session,
        bool entryRequiresDeferredTranscription,
        CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var updates = new List<UpdateDefinition<DocumentEntry>>
        {
            Builders<DocumentEntry>.Update.Set(e => e.AttachmentId, attachmentId),
            Builders<DocumentEntry>.Update.Set(
                e => e.Metadata["audioArchiveStatus"],
                DocumentRecordingArchiveStatus.Completed),
            Builders<DocumentEntry>.Update.Set(e => e.UpdatedAt, now),
        };
        if (entryRequiresDeferredTranscription)
        {
            // 与原文、索引更新原子落库。若进程在随后插入 run 前退出，下一轮仍能从
            // 该持久化意图恢复同一个确定性任务，不能用刚写入的原文反推客户端已收到。
            updates.Add(Builders<DocumentEntry>.Update.Set(
                e => e.Metadata[DeferredTranscriptionRequiredMetadataKey],
                "true"));
            updates.Add(Builders<DocumentEntry>.Update.Set(
                e => e.Metadata[DeferredTranscriptionRunIdMetadataKey],
                DeferredTranscriptionRunId(session.Id)));
        }
        string? completedLiveTranscript = null;
        if (session.LiveTranscriptStatus == DocumentLiveTranscriptStatus.Completed
            && !string.IsNullOrWhiteSpace(session.LiveTranscript))
        {
            completedLiveTranscript = session.LiveTranscript.Trim();
            updates.Add(Builders<DocumentEntry>.Update.Set(
                e => e.Metadata["liveTranscriptStatus"],
                DocumentLiveTranscriptStatus.Completed));
            updates.Add(Builders<DocumentEntry>.Update.Set(
                e => e.Metadata["liveTranscript"],
                completedLiveTranscript));
            if (!string.IsNullOrWhiteSpace(session.LiveTranscriptProvider))
            {
                updates.Add(Builders<DocumentEntry>.Update.Set(
                    e => e.Metadata["liveTranscriptProvider"],
                    session.LiveTranscriptProvider));
            }
            if (!string.IsNullOrWhiteSpace(session.LiveTranscriptModel))
            {
                updates.Add(Builders<DocumentEntry>.Update.Set(
                    e => e.Metadata["liveTranscriptModel"],
                    session.LiveTranscriptModel));
            }
        }

        await entries.UpdateOneAsync(
            e => e.Id == entryId,
            Builders<DocumentEntry>.Update.Combine(updates),
            cancellationToken: cancellationToken);

        if (completedLiveTranscript != null)
        {
            // SaveContentAsync 会在同一次更新中写入 DocumentId、Summary 与 ContentIndex。
            // 这里以 DocumentId 为空作为原子闸门：若完整录音转录已经生成正文，归档只能
            // 补附件和实时原文 metadata，不能再用较短的实时原文覆盖正文索引；若转录在
            // 本次条件更新之后完成，它自己的写入又会成为最后一次写，两个时序都安全。
            await entries.UpdateOneAsync(
                e => e.Id == entryId && e.DocumentId == null,
                Builders<DocumentEntry>.Update
                    .Set(
                        e => e.Summary,
                        completedLiveTranscript.Length > 200
                            ? completedLiveTranscript[..200]
                            : completedLiveTranscript)
                    .Set(
                        e => e.ContentIndex,
                        completedLiveTranscript.Length > 2000
                            ? completedLiveTranscript[..2000]
                            : completedLiveTranscript)
                    .Set(e => e.LastChangedAt, now),
                cancellationToken: cancellationToken);
        }
    }
}
