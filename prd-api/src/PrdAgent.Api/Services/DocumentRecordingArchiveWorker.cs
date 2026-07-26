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

            var entryUpdate = Builders<DocumentEntry>.Update.Combine(
                Builders<DocumentEntry>.Update.Set(e => e.AttachmentId, attachmentId),
                Builders<DocumentEntry>.Update.Set(
                    e => e.Metadata["audioArchiveStatus"],
                    DocumentRecordingArchiveStatus.Completed),
                Builders<DocumentEntry>.Update.Set(e => e.UpdatedAt, DateTime.UtcNow));
            if (latestSession.LiveTranscriptStatus == DocumentLiveTranscriptStatus.Completed
                && !string.IsNullOrWhiteSpace(latestSession.LiveTranscript))
            {
                var transcriptUpdates = new List<UpdateDefinition<DocumentEntry>>
                {
                    entryUpdate,
                    Builders<DocumentEntry>.Update.Set(
                        e => e.Metadata["liveTranscriptStatus"],
                        DocumentLiveTranscriptStatus.Completed),
                    Builders<DocumentEntry>.Update.Set(
                        e => e.Metadata["liveTranscript"],
                        latestSession.LiveTranscript.Trim()),
                };
                if (!string.IsNullOrWhiteSpace(latestSession.LiveTranscriptProvider))
                {
                    transcriptUpdates.Add(Builders<DocumentEntry>.Update.Set(
                        e => e.Metadata["liveTranscriptProvider"],
                        latestSession.LiveTranscriptProvider));
                }
                if (!string.IsNullOrWhiteSpace(latestSession.LiveTranscriptModel))
                {
                    transcriptUpdates.Add(Builders<DocumentEntry>.Update.Set(
                        e => e.Metadata["liveTranscriptModel"],
                        latestSession.LiveTranscriptModel));
                }
                entryUpdate = Builders<DocumentEntry>.Update.Combine(transcriptUpdates);
            }
            await db.DocumentEntries.UpdateOneAsync(
                e => e.Id == entry.Id,
                entryUpdate,
                cancellationToken: CancellationToken.None);

            var deferredRun = BuildDeferredTranscriptionRun(latestSession, entry.Id, instanceId);
            if (deferredRun != null)
            {
                try
                {
                    await db.DocumentStoreAgentRuns.InsertOneAsync(
                        deferredRun,
                        cancellationToken: CancellationToken.None);
                    _logger.LogInformation(
                        "[recording-archive] Deferred transcription queued session={SessionId} run={RunId}",
                        session.Id,
                        deferredRun.Id);
                }
                catch (MongoWriteException ex)
                    when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
                {
                    // Run ID 由 session ID 决定。崩溃重试只确认同一个任务已存在，
                    // 不会创建第二条转录任务。
                }
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
            if (completed.ModifiedCount == 1)
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
        string ownerInstanceId)
    {
        if (session.LiveTranscriptStatus == DocumentLiveTranscriptStatus.Completed
            && !string.IsNullOrWhiteSpace(session.LiveTranscript))
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
            Phase = "等待音频归档完成",
        };
    }

    internal static string DeferredTranscriptionRunId(string sessionId)
        => $"recording-archive-transcribe-{sessionId}";
}
