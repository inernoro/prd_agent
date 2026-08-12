using MongoDB.Bson;
using MongoDB.Driver;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 回收头像编辑产生的临时生图任务与内容寻址对象。
/// 已应用的预览立即回收，未应用的终态任务保留一段时间后由后台回收。
/// </summary>
public sealed class ProfileAvatarGenerationCleanupService : BackgroundService
{
    public const string AppKey = "profile-avatar";
    internal static readonly TimeSpan DefaultRetention = TimeSpan.FromHours(24);
    private static readonly TimeSpan CleanupInterval = TimeSpan.FromHours(1);
    private static readonly TimeSpan ObjectCleanupInterval = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan ObjectCleanupLease = TimeSpan.FromMinutes(2);
    private const int CleanupBatchSize = 50;
    private readonly Channel<(string runId, string ownerAdminId)> _cleanupQueue =
        Channel.CreateBounded<(string runId, string ownerAdminId)>(new BoundedChannelOptions(1000)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false
        });

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<ProfileAvatarGenerationCleanupService> _logger;
    private readonly TimeSpan _retention;

    public ProfileAvatarGenerationCleanupService(
        MongoDbContext db,
        IAssetStorage assetStorage,
        IConfiguration configuration,
        ILogger<ProfileAvatarGenerationCleanupService> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _logger = logger;
        var retentionHours = Math.Clamp(
            configuration.GetValue<int?>("ProfileAvatar:GenerationArtifactRetentionHours") ?? (int)DefaultRetention.TotalHours,
            1,
            168);
        _retention = TimeSpan.FromHours(retentionHours);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var nextExpiredCleanupAt = DateTime.MinValue;
        var nextObjectCleanupAt = DateTime.MinValue;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                while (_cleanupQueue.Reader.TryRead(out var queued))
                {
                    await CleanupRunAsync(queued.runId, queued.ownerAdminId, stoppingToken);
                }

                var now = DateTime.UtcNow;
                if (now >= nextExpiredCleanupAt)
                {
                    nextExpiredCleanupAt = now + CleanupInterval;
                    await CleanupExpiredAsync(now, stoppingToken);
                }
                if (now >= nextObjectCleanupAt)
                {
                    nextObjectCleanupAt = now + ObjectCleanupInterval;
                    await CleanupPendingAvatarObjectsAsync(now, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Profile avatar generation cleanup cycle failed");
            }

            try
            {
                var waitForQueue = _cleanupQueue.Reader.WaitToReadAsync(stoppingToken).AsTask();
                var nextScheduledCleanupAt = nextExpiredCleanupAt < nextObjectCleanupAt
                    ? nextExpiredCleanupAt
                    : nextObjectCleanupAt;
                var waitForExpiry = Task.Delay(
                    nextScheduledCleanupAt > DateTime.UtcNow
                        ? nextScheduledCleanupAt - DateTime.UtcNow
                        : TimeSpan.Zero,
                    stoppingToken);
                await Task.WhenAny(waitForQueue, waitForExpiry);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    public bool QueueRunCleanup(string runId, string ownerAdminId)
    {
        if (string.IsNullOrWhiteSpace(runId) || string.IsNullOrWhiteSpace(ownerAdminId)) return false;
        var accepted = _cleanupQueue.Writer.TryWrite((runId.Trim(), ownerAdminId.Trim()));
        if (!accepted)
        {
            _logger.LogWarning(
                "Profile avatar generation cleanup queue is full. userId={UserId} runId={RunId}",
                ownerAdminId,
                runId);
        }
        return accepted;
    }

    public async Task TrackAndTryDeleteSupersededAvatarAsync(
        string userId,
        string? previousFileName,
        string? currentFileName,
        CancellationToken ct)
    {
        if (!ProfileAvatarObjectCleanupPolicy.TryBuildObjectKey(
                userId,
                previousFileName,
                currentFileName,
                out var normalizedPreviousFileName,
                out var objectKey))
        {
            return;
        }

        var now = DateTime.UtcNow;
        var task = new ProfileAvatarObjectCleanupTask
        {
            Id = ProfileAvatarObjectCleanupPolicy.BuildTaskId(userId, objectKey),
            UserId = userId.Trim(),
            PreviousFileName = normalizedPreviousFileName,
            ObjectKey = objectKey,
            AttemptCount = 1,
            LastAttemptAt = now,
            NextAttemptAt = now + ObjectCleanupLease,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.ProfileAvatarObjectCleanupTasks.ReplaceOneAsync(
            x => x.Id == task.Id,
            task,
            new ReplaceOptions { IsUpsert = true },
            ct);
        await TryDeleteAvatarObjectAsync(task, ct);
    }

    internal async Task<int> CleanupPendingAvatarObjectsAsync(DateTime now, CancellationToken ct)
    {
        var cleaned = 0;
        while (!ct.IsCancellationRequested)
        {
            var dueFilter = Builders<ProfileAvatarObjectCleanupTask>.Filter.Lte(
                x => x.NextAttemptAt,
                now);
            var task = await _db.ProfileAvatarObjectCleanupTasks.FindOneAndUpdateAsync(
                dueFilter,
                Builders<ProfileAvatarObjectCleanupTask>.Update
                    .Set(x => x.LastAttemptAt, now)
                    .Set(x => x.NextAttemptAt, now + ObjectCleanupLease)
                    .Set(x => x.UpdatedAt, now)
                    .Inc(x => x.AttemptCount, 1),
                new FindOneAndUpdateOptions<ProfileAvatarObjectCleanupTask>
                {
                    Sort = Builders<ProfileAvatarObjectCleanupTask>.Sort.Ascending(x => x.NextAttemptAt),
                    ReturnDocument = ReturnDocument.After,
                },
                ct);
            if (task == null) break;
            if (await TryDeleteAvatarObjectAsync(task, ct)) cleaned++;
        }
        return cleaned;
    }

    private async Task<bool> TryDeleteAvatarObjectAsync(
        ProfileAvatarObjectCleanupTask task,
        CancellationToken ct)
    {
        try
        {
            if (!ProfileAvatarObjectCleanupPolicy.TryBuildObjectKey(
                    task.UserId,
                    task.PreviousFileName,
                    currentFileName: null,
                    out _,
                    out var validatedObjectKey)
                || !string.Equals(validatedObjectKey, task.ObjectKey, StringComparison.Ordinal))
            {
                await _db.ProfileAvatarObjectCleanupTasks.DeleteOneAsync(x => x.Id == task.Id, ct);
                return true;
            }

            await using var avatarMutationLease = await VideoAssetMutationLease.AcquireAsync(
                _db,
                ProfileAvatarObjectCleanupPolicy.BuildUserMutationLeaseKey(task.UserId),
                ct);
            var currentAvatarFileName = await _db.Users
                .Find(x => x.UserId == task.UserId)
                .Project(x => x.AvatarFileName)
                .FirstOrDefaultAsync(ct);
            if (string.Equals(
                    currentAvatarFileName?.Trim(),
                    task.PreviousFileName,
                    StringComparison.OrdinalIgnoreCase))
            {
                await _db.ProfileAvatarObjectCleanupTasks.DeleteOneAsync(x => x.Id == task.Id, ct);
                _logger.LogInformation(
                    "Superseded avatar cleanup cancelled because the file is active again. userId={UserId} file={File}",
                    task.UserId,
                    task.PreviousFileName);
                return true;
            }

            await _assetStorage.DeleteByKeyAsync(task.ObjectKey, ct);
            await _db.ProfileAvatarObjectCleanupTasks.DeleteOneAsync(x => x.Id == task.Id, ct);
            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            var retryAt = DateTime.UtcNow + RetryDelay(task.AttemptCount);
            _logger.LogWarning(
                ex,
                "Superseded self-service avatar cleanup deferred. userId={UserId} file={File} attempt={Attempt}",
                task.UserId,
                task.PreviousFileName,
                task.AttemptCount);
            try
            {
                await _db.ProfileAvatarObjectCleanupTasks.UpdateOneAsync(
                    x => x.Id == task.Id,
                    Builders<ProfileAvatarObjectCleanupTask>.Update
                        .Set(x => x.NextAttemptAt, retryAt)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
            }
            catch (Exception persistException)
            {
                // 初次删除前已持久化任务并预留租约；这里只是尽量提前下一次重试时间。
                _logger.LogError(
                    persistException,
                    "Superseded avatar retry schedule update failed; existing lease remains. taskId={TaskId}",
                    task.Id);
            }
            return false;
        }
    }

    private static TimeSpan RetryDelay(int attemptCount)
        => TimeSpan.FromMinutes(Math.Min(60, Math.Pow(2, Math.Clamp(attemptCount - 1, 0, 6))));

    internal async Task<int> CleanupExpiredAsync(DateTime now, CancellationToken ct)
    {
        var cutoff = now - _retention;
        var terminalStatuses = new[]
        {
            ImageGenRunStatus.Completed,
            ImageGenRunStatus.Failed,
            ImageGenRunStatus.Cancelled
        };
        var expiredFilter = Builders<ImageGenRun>.Filter.And(
            Builders<ImageGenRun>.Filter.Eq(x => x.AppKey, AppKey),
            Builders<ImageGenRun>.Filter.In(x => x.Status, terminalStatuses),
            Builders<ImageGenRun>.Filter.Or(
                Builders<ImageGenRun>.Filter.Lte(x => x.EndedAt, cutoff),
                Builders<ImageGenRun>.Filter.And(
                    Builders<ImageGenRun>.Filter.Eq(x => x.EndedAt, null),
                    Builders<ImageGenRun>.Filter.Lte(x => x.CreatedAt, cutoff))));
        var cleaned = 0;
        var failedRunIds = new HashSet<string>(StringComparer.Ordinal);
        while (!ct.IsCancellationRequested)
        {
            var filter = failedRunIds.Count == 0
                ? expiredFilter
                : Builders<ImageGenRun>.Filter.And(
                    expiredFilter,
                    Builders<ImageGenRun>.Filter.Nin(x => x.Id, failedRunIds));
            var candidates = await _db.ImageGenRuns
                .Find(filter)
                .SortBy(x => x.CreatedAt)
                .Limit(CleanupBatchSize)
                .Project(x => new { x.Id, x.OwnerAdminId })
                .ToListAsync(ct);
            if (candidates.Count == 0) break;

            foreach (var candidate in candidates)
            {
                if (await CleanupRunAsync(candidate.Id, candidate.OwnerAdminId, ct))
                {
                    cleaned++;
                }
                else
                {
                    failedRunIds.Add(candidate.Id);
                }
            }
        }
        return cleaned;
    }

    public async Task<bool> CleanupRunAsync(string runId, string ownerAdminId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(runId) || string.IsNullOrWhiteSpace(ownerAdminId)) return false;

        await using var runLease = await VideoAssetMutationLease.AcquireAsync(
            _db,
            $"profile-avatar-run:{runId}",
            ct);
        var run = await _db.ImageGenRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == ownerAdminId && x.AppKey == AppKey)
            .FirstOrDefaultAsync(ct);
        if (run == null || !IsTerminal(run.Status)) return false;

        var runArtifactFilter = Builders<UploadArtifact>.Filter.Regex(
            x => x.RequestId,
            new BsonRegularExpression($"^{System.Text.RegularExpressions.Regex.Escape(run.Id)}-\\d+-\\d+$"));
        var artifacts = await _db.UploadArtifacts.Find(runArtifactFilter).ToListAsync(ct);
        var artifactIds = artifacts.Select(x => x.Id).ToArray();
        var shas = artifacts
            .Select(x => NormalizeSha(x.Sha256))
            .Append(NormalizeSha(run.InitImageAssetSha256))
            .Concat(run.ImageRefs?.Select(x => NormalizeSha(x.AssetSha256)) ?? Enumerable.Empty<string?>())
            .Where(x => x != null)
            .Select(x => x!)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        try
        {
            foreach (var sha in shas)
            {
                await DeleteObjectWhenUnreferencedAsync(sha, run.Id, artifactIds, ct);
            }

            if (artifactIds.Length > 0)
            {
                await _db.UploadArtifacts.DeleteManyAsync(x => artifactIds.Contains(x.Id), ct);
            }
            await _db.ImageGenRunItems.DeleteManyAsync(x => x.RunId == run.Id, ct);
            await _db.ImageGenRunEvents.DeleteManyAsync(x => x.RunId == run.Id, ct);
            await _db.ImageGenRuns.DeleteOneAsync(x => x.Id == run.Id && x.AppKey == AppKey, ct);
            _logger.LogInformation(
                "Profile avatar generation artifacts cleaned. userId={UserId} runId={RunId} artifactCount={ArtifactCount}",
                ownerAdminId,
                run.Id,
                artifacts.Count);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "Profile avatar generation cleanup deferred. userId={UserId} runId={RunId}",
                ownerAdminId,
                run.Id);
            return false;
        }
    }

    private async Task DeleteObjectWhenUnreferencedAsync(
        string sha,
        string excludedRunId,
        IReadOnlyCollection<string> excludedArtifactIds,
        CancellationToken ct)
    {
        await using var assetLease = await VideoAssetMutationLease.AcquireAsync(
            _db,
            $"generated-image:{sha}",
            ct);
        var otherArtifactFilter = Builders<UploadArtifact>.Filter.Eq(x => x.Sha256, sha);
        if (excludedArtifactIds.Count > 0)
        {
            otherArtifactFilter &= Builders<UploadArtifact>.Filter.Nin(x => x.Id, excludedArtifactIds);
        }
        var otherRunFilter = Builders<ImageGenRun>.Filter.And(
            Builders<ImageGenRun>.Filter.Ne(x => x.Id, excludedRunId),
            Builders<ImageGenRun>.Filter.Or(
                Builders<ImageGenRun>.Filter.Eq(x => x.InitImageAssetSha256, sha),
                Builders<ImageGenRun>.Filter.Eq("ImageRefs.AssetSha256", sha)));

        var otherArtifactRefs = await _db.UploadArtifacts.CountDocumentsAsync(otherArtifactFilter, cancellationToken: ct);
        var imageAssetRefs = await _db.ImageAssets.CountDocumentsAsync(
            x => x.Sha256 == sha || x.OriginalSha256 == sha,
            cancellationToken: ct);
        var otherRunRefs = await _db.ImageGenRuns.CountDocumentsAsync(otherRunFilter, cancellationToken: ct);
        if (otherArtifactRefs == 0 && imageAssetRefs == 0 && otherRunRefs == 0)
        {
            await _assetStorage.DeleteByShaAsync(
                sha,
                ct,
                domain: AppDomainPaths.DomainVisualAgent,
                type: AppDomainPaths.TypeImg);
        }
    }

    private static bool IsTerminal(ImageGenRunStatus status)
        => status is ImageGenRunStatus.Completed or ImageGenRunStatus.Failed or ImageGenRunStatus.Cancelled;

    private static string? NormalizeSha(string? sha)
    {
        var normalized = (sha ?? string.Empty).Trim().ToLowerInvariant();
        return normalized.Length == 64 && normalized.All(Uri.IsHexDigit) ? normalized : null;
    }
}

public static class ProfileAvatarObjectCleanupPolicy
{
    public static string BuildUserMutationLeaseKey(string userId)
    {
        var ownerHash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes((userId ?? string.Empty).Trim())))
            .ToLowerInvariant();
        return $"profile-avatar-user:{ownerHash}";
    }

    public static string BuildOwnerPrefix(string userId)
    {
        var ownerHash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes((userId ?? string.Empty).Trim())))
            .ToLowerInvariant()[..12];
        return $"u-{ownerHash}-";
    }

    public static string BuildTaskId(string userId, string objectKey)
    {
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"profile-avatar-cleanup\0{userId.Trim()}\0{objectKey.Trim().ToLowerInvariant()}")))
            .ToLowerInvariant();
        return digest[..32];
    }

    public static bool TryBuildObjectKey(
        string userId,
        string? previousFileName,
        string? currentFileName,
        out string normalizedPreviousFileName,
        out string objectKey)
    {
        normalizedPreviousFileName = (previousFileName ?? string.Empty).Trim().ToLowerInvariant();
        var current = (currentFileName ?? string.Empty).Trim().ToLowerInvariant();
        objectKey = string.Empty;
        if (string.IsNullOrWhiteSpace(userId)
            || string.IsNullOrWhiteSpace(normalizedPreviousFileName)
            || string.Equals(normalizedPreviousFileName, current, StringComparison.Ordinal)
            || !normalizedPreviousFileName.StartsWith(BuildOwnerPrefix(userId), StringComparison.Ordinal))
        {
            return false;
        }

        objectKey = $"{AvatarUrlBuilder.AvatarPathPrefix}/{normalizedPreviousFileName}";
        return AssetStorageDeletePolicy.IsVersionedUserAvatarKey(objectKey);
    }
}
