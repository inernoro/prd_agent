using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 持久化回收合成验收文档产生的受控对象。删除任务先于数据库级联登记，
/// Worker 只有在附件引用全部解除后才删除对象，避免数据库失败留下断链记录。
/// </summary>
public sealed class DocumentAssetCleanupService : BackgroundService
{
    internal const string ManagedKeyPrefix = "_it/stable-smoke-document/";
    internal const string PendingUploadPurpose = "pending-upload";
    internal const string DeleteAfterUnlinkPurpose = "delete-after-unlink";
    private static readonly TimeSpan ScanInterval = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan CleanupLease = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan PendingUploadGrace = TimeSpan.FromMinutes(15);
    private readonly Channel<bool> _wakeQueue = Channel.CreateBounded<bool>(new BoundedChannelOptions(1)
    {
        FullMode = BoundedChannelFullMode.DropWrite,
        SingleReader = true,
        SingleWriter = false,
    });

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<DocumentAssetCleanupService> _logger;

    public DocumentAssetCleanupService(
        MongoDbContext db,
        IAssetStorage assetStorage,
        ILogger<DocumentAssetCleanupService> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _logger = logger;
    }

    public async Task TrackPendingAsync(
        IReadOnlyCollection<Attachment> attachments,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        foreach (var storageKey in attachments
                     .Select(attachment => attachment.StorageKey?.Trim())
                     .Where(IsManagedStorageKey)
                     .Select(storageKey => storageKey!)
                     .Distinct(StringComparer.Ordinal))
        {
            var taskId = BuildTaskId(storageKey);
            await _db.DocumentAssetCleanupTasks.UpdateOneAsync(
                candidate => candidate.Id == taskId,
                Builders<DocumentAssetCleanupTask>.Update
                    .SetOnInsert(candidate => candidate.Id, taskId)
                    .SetOnInsert(candidate => candidate.StorageKey, storageKey)
                    .SetOnInsert(candidate => candidate.AttemptCount, 0)
                    .SetOnInsert(candidate => candidate.CreatedAt, now)
                    .Set(candidate => candidate.Purpose, DeleteAfterUnlinkPurpose)
                    .Set(candidate => candidate.NextAttemptAt, now)
                    .Set(candidate => candidate.UpdatedAt, now),
                new UpdateOptions { IsUpsert = true },
                ct);
        }

        _wakeQueue.Writer.TryWrite(true);
    }

    /// <summary>
    /// 对象写入前先登记回滚意图。宽限期覆盖附件、正文和条目的正常写入；
    /// 若进程中断，后台仍能在确认没有有效条目引用后回收对象。
    /// </summary>
    public Task TrackPendingUploadAsync(string storageKey, CancellationToken ct)
    {
        if (!IsManagedStorageKey(storageKey))
            throw new InvalidOperationException("Pending document upload must use a managed test key.");

        var now = DateTime.UtcNow;
        var taskId = BuildTaskId(storageKey);
        return _db.DocumentAssetCleanupTasks.UpdateOneAsync(
            candidate => candidate.Id == taskId,
            Builders<DocumentAssetCleanupTask>.Update
                .SetOnInsert(candidate => candidate.Id, taskId)
                .SetOnInsert(candidate => candidate.StorageKey, storageKey)
                .SetOnInsert(candidate => candidate.AttemptCount, 0)
                .SetOnInsert(candidate => candidate.CreatedAt, now)
                .Set(candidate => candidate.Purpose, PendingUploadPurpose)
                .Set(candidate => candidate.NextAttemptAt, now + PendingUploadGrace)
                .Set(candidate => candidate.UpdatedAt, now),
            new UpdateOptions { IsUpsert = true },
            ct);
    }

    public Task MarkUploadCommittedAsync(string? storageKey, CancellationToken ct)
    {
        if (!IsManagedStorageKey(storageKey)) return Task.CompletedTask;
        var taskId = BuildTaskId(storageKey!);
        return _db.DocumentAssetCleanupTasks.DeleteOneAsync(
            candidate => candidate.Id == taskId && candidate.Purpose == PendingUploadPurpose,
            ct);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                while (_wakeQueue.Reader.TryRead(out _)) { }
                await CleanupPendingAsync(DateTime.UtcNow, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Document asset cleanup cycle failed");
            }

            try
            {
                var wake = _wakeQueue.Reader.WaitToReadAsync(stoppingToken).AsTask();
                var nextScan = Task.Delay(ScanInterval, stoppingToken);
                await Task.WhenAny(wake, nextScan);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    internal async Task<int> CleanupPendingAsync(DateTime now, CancellationToken ct)
    {
        var cleaned = 0;
        while (!ct.IsCancellationRequested)
        {
            var dueFilter = Builders<DocumentAssetCleanupTask>.Filter.Lte(
                candidate => candidate.NextAttemptAt,
                now);
            var task = await _db.DocumentAssetCleanupTasks.FindOneAndUpdateAsync(
                dueFilter,
                Builders<DocumentAssetCleanupTask>.Update
                    .Set(candidate => candidate.LastAttemptAt, now)
                    .Set(candidate => candidate.NextAttemptAt, now + CleanupLease)
                    .Set(candidate => candidate.UpdatedAt, now)
                    .Inc(candidate => candidate.AttemptCount, 1),
                new FindOneAndUpdateOptions<DocumentAssetCleanupTask>
                {
                    Sort = Builders<DocumentAssetCleanupTask>.Sort.Ascending(candidate => candidate.NextAttemptAt),
                    ReturnDocument = ReturnDocument.After,
                },
                ct);
            if (task == null) break;
            if (await TryDeleteAsync(task, ct)) cleaned++;
        }
        return cleaned;
    }

    private async Task<bool> TryDeleteAsync(DocumentAssetCleanupTask task, CancellationToken ct)
    {
        try
        {
            if (!IsManagedStorageKey(task.StorageKey)
                || !string.Equals(task.Id, BuildTaskId(task.StorageKey), StringComparison.Ordinal))
            {
                await _db.DocumentAssetCleanupTasks.DeleteOneAsync(candidate => candidate.Id == task.Id, ct);
                return true;
            }

            var purpose = string.IsNullOrWhiteSpace(task.Purpose)
                ? DeleteAfterUnlinkPurpose
                : task.Purpose;
            var attachments = await _db.Attachments
                .Find(attachment => attachment.StorageKey == task.StorageKey)
                .Project(attachment => attachment.AttachmentId)
                .ToListAsync(ct);
            if (purpose == PendingUploadPurpose && attachments.Count > 0)
            {
                var hasCommittedEntry = await _db.DocumentEntries.CountDocumentsAsync(
                    entry => entry.AttachmentId != null && attachments.Contains(entry.AttachmentId),
                    cancellationToken: ct) > 0;
                if (hasCommittedEntry)
                {
                    await _db.DocumentAssetCleanupTasks.DeleteOneAsync(candidate => candidate.Id == task.Id, ct);
                    return true;
                }

                // 附件已写但条目未提交：回滚仅属于受控合成上传的孤儿附件。
                await _db.Attachments.DeleteManyAsync(
                    attachment => attachments.Contains(attachment.AttachmentId),
                    ct);
                attachments.Clear();
            }
            if (attachments.Count > 0)
            {
                await RescheduleAsync(task, ScanInterval, ct);
                return false;
            }

            await _assetStorage.DeleteByKeyAsync(task.StorageKey, ct);
            await _db.DocumentAssetCleanupTasks.DeleteOneAsync(candidate => candidate.Id == task.Id, ct);
            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "Document asset cleanup deferred. taskId={TaskId} attempt={Attempt}",
                task.Id,
                task.AttemptCount);
            await RescheduleAsync(task, RetryDelay(task.AttemptCount), CancellationToken.None);
            return false;
        }
    }

    private Task RescheduleAsync(DocumentAssetCleanupTask task, TimeSpan delay, CancellationToken ct)
        => _db.DocumentAssetCleanupTasks.UpdateOneAsync(
            candidate => candidate.Id == task.Id,
            Builders<DocumentAssetCleanupTask>.Update
                .Set(candidate => candidate.NextAttemptAt, DateTime.UtcNow + delay)
                .Set(candidate => candidate.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

    internal static bool IsManagedStorageKey(string? storageKey)
        => !string.IsNullOrWhiteSpace(storageKey)
           && storageKey.StartsWith(ManagedKeyPrefix, StringComparison.Ordinal)
           && !storageKey.Contains("..", StringComparison.Ordinal)
           && !storageKey.Contains('\\');

    internal static string BuildTaskId(string storageKey)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(storageKey))).ToLowerInvariant();

    private static TimeSpan RetryDelay(int attemptCount)
        => TimeSpan.FromMinutes(Math.Min(60, Math.Pow(2, Math.Clamp(attemptCount - 1, 0, 6))));
}
