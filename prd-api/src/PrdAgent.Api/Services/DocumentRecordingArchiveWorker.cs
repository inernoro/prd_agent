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
    private const string DeferredTranscriptionRunPrefix = "recording-archive-transcribe-";
    internal const int MaxDeferredTranscriptionAutomaticRetries = 3;
    internal const string DeferredRetryReasonRestartInterrupted = "restart-interrupted";
    internal const string DeferredRetryReasonExecutionFailed = "execution-failed";
    internal const string DeferredTranscriptionRequiredMetadataKey = "deferredTranscriptionRequired";
    internal const string DeferredTranscriptionRunIdMetadataKey = "deferredTranscriptionRunId";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan ExpiredCleanupInterval = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan StaleLease = TimeSpan.FromMinutes(10);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<DocumentRecordingArchiveWorker> _logger;
    private DateTime _nextExpiredCleanupAt = DateTime.MinValue;

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
        if (now >= _nextExpiredCleanupAt)
        {
            // 清理失败不能阻断归档主队列，也不能每 15 秒无索引扫一次集合。先推进
            // 下次时间，再独立捕获异常；重启会立即补扫，常驻实例每十分钟兜底一次。
            _nextExpiredCleanupAt = now.Add(ExpiredCleanupInterval);
            try
            {
                var cleaned = await CleanupExpiredArchivedSessionsAsync(
                    db.DocumentRecordingUploadSessions,
                    db.DocumentRecordingUploadChunks,
                    now,
                    CancellationToken.None);
                if (cleaned > 0)
                {
                    _logger.LogInformation(
                        "[recording-archive] Cleaned {Count} expired archived recording sessions",
                        cleaned);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[recording-archive] Expired archive cleanup failed");
            }
        }

        // 转录 outbox 必须独立于对象存储归档处理。即使进程在“会话终态提交”与
        // “run 插入”之间退出，或者 R2/COS 仍不可用，下一轮也会先从 Mongo 分片
        // 恢复固定 ID 的完整音频转录任务，不依赖浏览器再次调用 /complete。
        var recoveredRuns = await RecoverDeferredTranscriptionRunsAsync(
            db.DocumentRecordingUploadSessions,
            db.DocumentEntries,
            db.DocumentStoreAgentRuns,
            instanceId,
            CancellationToken.None);
        if (recoveredRuns > 0)
        {
            _logger.LogInformation(
                "[recording-archive] Recovered {Count} deferred transcription run(s)",
                recoveredRuns);
        }

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

            var deferredRun = await EnsureAndAcknowledgeDeferredTranscriptionRunAsync(
                db.DocumentRecordingUploadSessions,
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

            var archiveCompletedAt = DateTime.UtcNow;
            UpdateDefinition<DocumentRecordingUploadSession> archiveCompletedUpdate =
                Builders<DocumentRecordingUploadSession>.Update
                    .Set(s => s.ArchiveStatus, DocumentRecordingArchiveStatus.Completed)
                    .Unset(s => s.ArchiveLeaseId)
                    .Set(s => s.ArchiveUrl, stored.Url)
                    .Set(s => s.ArchiveError, null)
                    .Set(s => s.ArchiveNextAttemptAt, null)
                    .Set(s => s.UpdatedAt, archiveCompletedAt);
            if (!entryRequiresDeferredTranscription)
            {
                archiveCompletedUpdate = archiveCompletedUpdate.Set(
                    s => s.ExpiresAt,
                    CompletedSessionExpiresAt(archiveCompletedAt));
            }
            var completed = await db.DocumentRecordingUploadSessions.UpdateOneAsync(
                s => s.Id == session.Id
                     && s.OwnerInstanceId == instanceId
                     && s.ArchiveStatus == DocumentRecordingArchiveStatus.Archiving
                     && s.ArchiveLeaseId == archiveLeaseId,
                archiveCompletedUpdate,
                cancellationToken: CancellationToken.None);
            // 延迟转录可能已经开始读取 Mongo 分片。归档成功与转录读取并发时，只有
            // 不需要延迟转录，或转录已经写出正文，才可释放分片。完成会话更新后必须
            // 回读 run，不能使用 Ensure 返回的旧快照，否则恰好并发完成时仍会泄漏。
            DocumentStoreAgentRun? completedDeferredRun = null;
            if (completed.ModifiedCount == 1 && entryRequiresDeferredTranscription)
            {
                completedDeferredRun = await db.DocumentStoreAgentRuns
                    .Find(r => r.Id == DeferredTranscriptionRunId(session.Id))
                    .FirstOrDefaultAsync(CancellationToken.None);
            }
            if (completed.ModifiedCount == 1
                && ShouldDeleteChunksAfterArchive(
                    entryRequiresDeferredTranscription,
                    completedDeferredRun))
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
            // 固定 ID 只负责去重，不能把任意 Failed/Cancelled 都解释成重试请求。
            // 是否重放由持久化的次数、时间和原因共同决定，人工取消永不自动恢复。
            return await runs.Find(r => r.Id == run.Id).FirstOrDefaultAsync(cancellationToken);
        }
    }

    internal static async Task<DocumentStoreAgentRun?> TryRequeueDeferredTranscriptionRunAsync(
        IMongoCollection<DocumentStoreAgentRun> runs,
        DocumentStoreAgentRun run,
        string ownerInstanceId,
        DateTime utcNow,
        CancellationToken cancellationToken)
    {
        if (run.Status != DocumentStoreRunStatus.Failed
            || run.AutomaticRetryNextAt == null
            || run.AutomaticRetryNextAt > utcNow
            || run.AutomaticRetryCount >= MaxDeferredTranscriptionAutomaticRetries)
        {
            return run;
        }

        var retryFilter = Builders<DocumentStoreAgentRun>.Filter.And(
            Builders<DocumentStoreAgentRun>.Filter.Eq(candidate => candidate.Id, run.Id),
            Builders<DocumentStoreAgentRun>.Filter.Eq(
                candidate => candidate.Status,
                DocumentStoreRunStatus.Failed),
            Builders<DocumentStoreAgentRun>.Filter.Ne(
                candidate => candidate.AutomaticRetryNextAt,
                null),
            Builders<DocumentStoreAgentRun>.Filter.Lte(
                candidate => candidate.AutomaticRetryNextAt,
                utcNow),
            Builders<DocumentStoreAgentRun>.Filter.Lt(
                candidate => candidate.AutomaticRetryCount,
                MaxDeferredTranscriptionAutomaticRetries));
        var requeued = await runs.FindOneAndUpdateAsync(
            retryFilter,
            Builders<DocumentStoreAgentRun>.Update
                .Set(candidate => candidate.Status, DocumentStoreRunStatus.Queued)
                .Set(candidate => candidate.Phase, "等待完整录音转录")
                .Set(candidate => candidate.Progress, 0)
                .Set(candidate => candidate.ErrorMessage, null)
                .Set(candidate => candidate.StartedAt, null)
                .Set(candidate => candidate.EndedAt, null)
                .Set(candidate => candidate.OwnerInstanceId, ownerInstanceId)
                .Set(candidate => candidate.AutomaticRetryNextAt, null)
                .Inc(candidate => candidate.AutomaticRetryCount, 1),
            new FindOneAndUpdateOptions<DocumentStoreAgentRun, DocumentStoreAgentRun>
            {
                ReturnDocument = ReturnDocument.After,
            },
            cancellationToken);
        return requeued
               ?? await runs.Find(candidate => candidate.Id == run.Id)
                   .FirstOrDefaultAsync(cancellationToken);
    }

    internal static TimeSpan ComputeDeferredTranscriptionRetryBackoff(int completedRetries)
        => completedRetries switch
        {
            <= 0 => TimeSpan.FromSeconds(30),
            1 => TimeSpan.FromMinutes(2),
            _ => TimeSpan.FromMinutes(10),
        };

    internal static bool IsDeferredTranscriptionRunId(string? runId)
        => runId?.StartsWith(DeferredTranscriptionRunPrefix, StringComparison.Ordinal) == true;

    internal static bool HasDeferredTranscriptionAutomaticRetryBudget(
        DocumentStoreAgentRun run)
        => IsDeferredTranscriptionRunId(run.Id)
           && run.AutomaticRetryCount < MaxDeferredTranscriptionAutomaticRetries;

    internal static FilterDefinition<DocumentStoreAgentRun>
        BuildDeferredTranscriptionAutomaticRetryBudgetFilter()
        => Builders<DocumentStoreAgentRun>.Filter.Or(
            Builders<DocumentStoreAgentRun>.Filter.Exists(
                nameof(DocumentStoreAgentRun.AutomaticRetryCount),
                false),
            Builders<DocumentStoreAgentRun>.Filter.Lt(
                run => run.AutomaticRetryCount,
                MaxDeferredTranscriptionAutomaticRetries));

    internal static async Task<DocumentStoreAgentRun?> EnsureAndAcknowledgeDeferredTranscriptionRunAsync(
        IMongoCollection<DocumentRecordingUploadSession> sessions,
        IMongoCollection<DocumentStoreAgentRun> runs,
        DocumentRecordingUploadSession session,
        string entryId,
        string ownerInstanceId,
        bool entryRequiresDeferredTranscription,
        CancellationToken cancellationToken)
    {
        var run = await EnsureDeferredTranscriptionRunAsync(
            runs,
            session,
            entryId,
            ownerInstanceId,
            entryRequiresDeferredTranscription,
            cancellationToken);
        if (run == null)
            return null;

        run = await TryRequeueDeferredTranscriptionRunAsync(
            runs,
            run,
            ownerInstanceId,
            DateTime.UtcNow,
            cancellationToken);
        if (run == null)
            return null;

        // outbox 覆盖的是“完整转录成功”而不只是“run 已创建”。Queued/Running/Failed
        // 期间必须保持 pending，容器重启把 Running 标成 Failed 后，下一轮才能重新排队。
        // Done 后才确认；若进程恰好在 Done 与确认之间退出，下一轮会幂等补确认。
        if (run.Status == DocumentStoreRunStatus.Done)
        {
            await AcknowledgeDeferredTranscriptionSuccessAsync(
                sessions,
                run.Id,
                entryId,
                cancellationToken);
        }
        else
        {
            // 轮转扫描游标，避免前 25 个长任务长期占住 limit，饿死后续 outbox。
            var pendingAt = DateTime.UtcNow;
            await sessions.UpdateOneAsync(
                candidate => candidate.Id == session.Id
                             && candidate.EntryId == entryId
                             && candidate.DeferredTranscriptionRunPending,
                Builders<DocumentRecordingUploadSession>.Update
                    .Set(candidate => candidate.UpdatedAt, pendingAt)
                    .Set(candidate => candidate.ExpiresAt, PendingOutboxExpiresAt(pendingAt)),
                cancellationToken: cancellationToken);
        }
        return run;
    }

    internal static async Task<bool> AcknowledgeDeferredTranscriptionSuccessAsync(
        IMongoCollection<DocumentRecordingUploadSession> sessions,
        string runId,
        string entryId,
        CancellationToken cancellationToken)
    {
        if (!runId.StartsWith(DeferredTranscriptionRunPrefix, StringComparison.Ordinal))
            return false;
        var sessionId = runId[DeferredTranscriptionRunPrefix.Length..];
        if (string.IsNullOrWhiteSpace(sessionId))
            return false;

        var acknowledgedAt = DateTime.UtcNow;
        var acknowledged = await sessions.UpdateOneAsync(
            candidate => candidate.Id == sessionId
                         && candidate.EntryId == entryId
                         && candidate.DeferredTranscriptionRunPending,
            Builders<DocumentRecordingUploadSession>.Update
                .Set(candidate => candidate.DeferredTranscriptionRunPending, false)
                .Set(candidate => candidate.UpdatedAt, acknowledgedAt)
                .Set(candidate => candidate.ExpiresAt, CompletedSessionExpiresAt(acknowledgedAt)),
            cancellationToken: cancellationToken);
        return acknowledged.ModifiedCount == 1;
    }

    internal static async Task<int> RecoverDeferredTranscriptionRunsAsync(
        IMongoCollection<DocumentRecordingUploadSession> sessions,
        IMongoCollection<DocumentEntry> entries,
        IMongoCollection<DocumentStoreAgentRun> runs,
        string ownerInstanceId,
        CancellationToken cancellationToken,
        int limit = 25)
    {
        var candidates = await sessions
            .Find(session => session.OwnerInstanceId == ownerInstanceId
                             && session.Status == DocumentRecordingUploadStatus.Completed
                             && session.DeferredTranscriptionRunPending
                             && session.EntryId != null
                             && session.EntryId != string.Empty)
            .SortBy(session => session.UpdatedAt)
            .Limit(Math.Clamp(limit, 1, 100))
            .ToListAsync(cancellationToken);
        var recovered = 0;
        foreach (var session in candidates)
        {
            var entryId = session.EntryId!;
            var entryExists = await entries
                .Find(entry => entry.Id == entryId && entry.StoreId == session.StoreId)
                .AnyAsync(cancellationToken);
            if (!entryExists)
            {
                // 用户已删除条目时不再制造必然失败的孤儿 run；条件更新保证不会
                // 覆盖同一会话后来指向的新条目。
                var discardedAt = DateTime.UtcNow;
                await sessions.UpdateOneAsync(
                    candidate => candidate.Id == session.Id
                                 && candidate.EntryId == entryId
                                 && candidate.DeferredTranscriptionRunPending,
                    Builders<DocumentRecordingUploadSession>.Update
                        .Set(candidate => candidate.DeferredTranscriptionRunPending, false)
                        .Set(candidate => candidate.UpdatedAt, discardedAt)
                        .Set(candidate => candidate.ExpiresAt, CompletedSessionExpiresAt(discardedAt)),
                    cancellationToken: cancellationToken);
                continue;
            }

            var run = await EnsureAndAcknowledgeDeferredTranscriptionRunAsync(
                sessions,
                runs,
                session,
                entryId,
                ownerInstanceId,
                entryRequiresDeferredTranscription: true,
                cancellationToken);
            if (run != null)
                recovered++;
        }

        return recovered;
    }

    internal static async Task<bool> PersistDeferredTranscriptionIntentAsync(
        IMongoCollection<DocumentEntry> entries,
        DocumentEntry entry,
        string sessionId,
        bool entryRequiresDeferredTranscription,
        CancellationToken cancellationToken)
    {
        if (!entryRequiresDeferredTranscription)
            return false;

        var runId = DeferredTranscriptionRunId(sessionId);
        entry.Metadata ??= new Dictionary<string, string>();
        entry.Metadata[DeferredTranscriptionRequiredMetadataKey] = "true";
        entry.Metadata[DeferredTranscriptionRunIdMetadataKey] = runId;
        var update = Builders<DocumentEntry>.Update.Combine(
            Builders<DocumentEntry>.Update.Set(
                e => e.Metadata[DeferredTranscriptionRequiredMetadataKey],
                "true"),
            Builders<DocumentEntry>.Update.Set(
                e => e.Metadata[DeferredTranscriptionRunIdMetadataKey],
                runId),
            Builders<DocumentEntry>.Update.Set(e => e.LastChangedAt, DateTime.UtcNow));
        var persisted = await entries.UpdateOneAsync(
            e => e.Id == entry.Id,
            update,
            cancellationToken: cancellationToken);
        return persisted.MatchedCount == 1;
    }

    internal static string DeferredTranscriptionRunId(string sessionId)
        => $"{DeferredTranscriptionRunPrefix}{sessionId}";

    internal static bool ShouldDeleteChunksAfterArchive(
        bool entryRequiresDeferredTranscription,
        DocumentStoreAgentRun? deferredRun)
        => !entryRequiresDeferredTranscription
           || deferredRun?.Status == DocumentStoreRunStatus.Done
           || !string.IsNullOrWhiteSpace(deferredRun?.OutputEntryId);

    internal static async Task<bool> DeleteArchivedChunksAfterSuccessfulTranscriptionAsync(
        IMongoCollection<DocumentRecordingUploadSession> sessions,
        IMongoCollection<DocumentRecordingUploadChunk> chunks,
        DocumentEntry entry,
        CancellationToken cancellationToken)
    {
        var sessionId = entry.Metadata?.GetValueOrDefault("recordingUploadSessionId")?.Trim();
        if (string.IsNullOrWhiteSpace(sessionId))
            return false;

        var archiveCompleted = await sessions
            .Find(s => s.Id == sessionId
                       && s.ArchiveStatus == DocumentRecordingArchiveStatus.Completed)
            .AnyAsync(cancellationToken);
        if (!archiveCompleted)
            return false;

        await chunks.DeleteManyAsync(
            c => c.SessionId == sessionId,
            cancellationToken: cancellationToken);
        return true;
    }

    internal static async Task<int> CleanupExpiredArchivedSessionsAsync(
        IMongoCollection<DocumentRecordingUploadSession> sessions,
        IMongoCollection<DocumentRecordingUploadChunk> chunks,
        DateTime now,
        CancellationToken cancellationToken,
        int limit = 100)
    {
        var batchSize = Math.Clamp(limit, 1, 500);
        var expiredSessionIds = await sessions
            .Find(s => s.ArchiveStatus == DocumentRecordingArchiveStatus.Completed
                       && !s.DeferredTranscriptionRunPending
                       && s.ExpiresAt <= now)
            .SortBy(s => s.ExpiresAt)
            .Limit(batchSize)
            .Project(s => s.Id)
            .ToListAsync(cancellationToken);
        if (expiredSessionIds.Count == 0)
            return 0;

        // 分片必须先删。若第一步失败，会话仍在，下一轮 Worker 可以重试；先删会话
        // 会让残留分片失去可定位的父记录。只处理已归档会话，pending 音频绝不回收。
        await chunks.DeleteManyAsync(
            c => expiredSessionIds.Contains(c.SessionId),
            cancellationToken: cancellationToken);
        await sessions.DeleteManyAsync(
            s => expiredSessionIds.Contains(s.Id)
                 && s.ArchiveStatus == DocumentRecordingArchiveStatus.Completed
                 && !s.DeferredTranscriptionRunPending
                 && s.ExpiresAt <= now,
            cancellationToken: cancellationToken);
        return expiredSessionIds.Count;
    }

    internal static DateTime PendingOutboxExpiresAt(DateTime now)
        => now.AddYears(10);

    internal static DateTime CompletedSessionExpiresAt(DateTime now)
        => now.AddDays(1);

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
