using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 网页托管 ZIP 的保守型优化器：只移除确定不参与浏览器运行的开发文件，并把可从包内
/// node_modules 精确找到的公共 CDN 依赖收敛到 vendor。任何不确定性都保留或阻断。
/// </summary>
public sealed partial class HostedSiteOptimizationService : IHostedSiteOptimizationService
{
    private const int UploadChunkSize = 2 * 1024 * 1024;
    private const long MaxSourceFileBytes = 500L * 1024 * 1024;
    private const int MaxArchiveEntries = 20_000;
    private const long MaxUncompressedBytes = 500L * 1024 * 1024;
    private const long MaxOptimizationBytes = 200L * 1024 * 1024;
    private const long MaxScannedTextFileBytes = 8L * 1024 * 1024;
    private const long MaxScannedTextBytes = 32L * 1024 * 1024;
    private static readonly TimeSpan SessionLifetime = TimeSpan.FromHours(2);
    private static readonly TimeSpan WorkerLeaseLifetime = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan CleanupRetryDelay = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan WorkerLeaseHeartbeat = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan QueueStallThreshold = TimeSpan.FromMinutes(15);
    private const int QueueBacklogThreshold = 100;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    private static readonly HashSet<string> DevelopmentDirectoryNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", ".cache", ".parcel-cache", ".turbo", ".vite", "coverage",
        "screenshots", "test-results", "tests", "__tests__",
    };

    private static readonly HashSet<string> DevelopmentFileNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ".DS_Store", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
        "tsconfig.json", "vite.config.js", "vite.config.ts", "eslint.config.js",
    };

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _storage;
    private readonly IHostedSiteService _hostedSites;
    private readonly ILogger<HostedSiteOptimizationService> _logger;

    public HostedSiteOptimizationService(
        MongoDbContext db,
        IAssetStorage storage,
        IHostedSiteService hostedSites,
        ILogger<HostedSiteOptimizationService> logger)
    {
        _db = db;
        _storage = storage;
        _hostedSites = hostedSites;
        _logger = logger;
    }

    public HostedSiteOptimizationAnalysis Analyze(byte[] zipBytes)
        => BuildOptimizedPackage(zipBytes).Analysis;

    public async Task<HostedSiteOptimizationSession> CreateUploadAsync(
        string userId,
        CreateHostedSiteOptimizationUploadRequest request,
        CancellationToken ct = default)
    {
        if (request.FileSize <= 0)
            throw new InvalidOperationException("请选择非空 ZIP 文件");
        if (request.FileSize > MaxSourceFileBytes)
            throw new InvalidOperationException("ZIP 文件不能超过 500 MB");
        if (!string.Equals(Path.GetExtension(request.FileName), ".zip", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("智能优化目前只支持 ZIP 文件");
        if (!string.IsNullOrWhiteSpace(request.TargetSiteId)
            && await _hostedSites.GetByIdAsync(request.TargetSiteId, userId, ct) == null)
            throw new KeyNotFoundException("站点不存在");

        var now = DateTime.UtcNow;
        var session = new HostedSiteOptimizationSession
        {
            TemporaryStorageId = Guid.NewGuid().ToString("N"),
            OwnerUserId = userId,
            TargetSiteId = string.IsNullOrWhiteSpace(request.TargetSiteId) ? null : request.TargetSiteId.Trim(),
            SourceFileName = Path.GetFileName(request.FileName),
            SourceFileSize = request.FileSize,
            ChunkSize = UploadChunkSize,
            TotalChunks = checked((int)((request.FileSize + UploadChunkSize - 1) / UploadChunkSize)),
            Status = HostedSiteOptimizationStatuses.Uploading,
            Title = request.Title?.Trim(),
            Description = request.Description?.Trim(),
            Folder = request.Folder?.Trim(),
            Tags = (request.Tags ?? new List<string>())
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.Trim())
                .Distinct()
                .ToList(),
            CreatedAt = now,
            UpdatedAt = now,
            ExpiresAt = now.Add(SessionLifetime),
        };
        await _db.HostedSiteOptimizationSessions.InsertOneAsync(
            session,
            cancellationToken: CancellationToken.None);
        return session;
    }

    public async Task UploadChunkAsync(
        string sessionId,
        string userId,
        int chunkIndex,
        byte[] chunkBytes,
        CancellationToken ct = default)
    {
        var session = await GetOwnedSessionAsync(sessionId, userId, ct);
        if (session.Status != HostedSiteOptimizationStatuses.Uploading)
            throw new InvalidOperationException("这个上传任务已经结束，请重新选择文件");
        if (chunkIndex < 0 || chunkIndex >= session.TotalChunks)
            throw new InvalidOperationException("分片序号无效，请重新上传");

        var expected = chunkIndex == session.TotalChunks - 1
            ? session.SourceFileSize - (long)session.ChunkSize * (session.TotalChunks - 1)
            : session.ChunkSize;
        if (chunkBytes.LongLength != expected)
            throw new InvalidOperationException("上传分片不完整，请重试当前文件");

        var key = BuildChunkKey(session, chunkIndex);
        await _storage.UploadToKeyAsync(
            key,
            chunkBytes,
            "application/octet-stream",
            CancellationToken.None,
            "private, no-store");
        var update = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
            x => x.Id == session.Id
                 && x.OwnerUserId == userId
                 && x.Status == HostedSiteOptimizationStatuses.Uploading,
            Builders<HostedSiteOptimizationSession>.Update
                .AddToSet(x => x.UploadedChunkIndexes, chunkIndex)
                .Set(x => x.UpdatedAt, DateTime.UtcNow)
                .Set(x => x.ExpiresAt, DateTime.UtcNow.Add(SessionLifetime)),
            cancellationToken: CancellationToken.None);
        if (update.MatchedCount == 0)
        {
            // 分片键是确定性的：另一个幂等重试可能已用同一键完成上传并推进状态。
            // 这里不能删除共享键；会话取消或过期时由统一清理流程回收。
            throw new InvalidOperationException("这个上传任务已经结束，请重新选择文件");
        }
    }

    public async Task QueueUploadAsync(string sessionId, string userId, CancellationToken ct = default)
    {
        var session = await GetOwnedSessionAsync(sessionId, userId, ct);
        if (session.Status != HostedSiteOptimizationStatuses.Uploading)
        {
            if (session.Status is HostedSiteOptimizationStatuses.Queued
                or HostedSiteOptimizationStatuses.Analyzing
                or HostedSiteOptimizationStatuses.AwaitingDecision
                or HostedSiteOptimizationStatuses.Previewing
                or HostedSiteOptimizationStatuses.PreviewReady
                or HostedSiteOptimizationStatuses.Saving
                or HostedSiteOptimizationStatuses.Saved)
                return;
            throw new InvalidOperationException("这个上传任务已经结束，请重新选择文件");
        }
        if (session.UploadedChunkIndexes.Distinct().Count() != session.TotalChunks)
            throw new InvalidOperationException("文件尚未完整上传，请重试未完成的分片");

        var update = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
            x => x.Id == session.Id
                 && x.OwnerUserId == userId
                 && x.Status == HostedSiteOptimizationStatuses.Uploading,
            Builders<HostedSiteOptimizationSession>.Update
                .Set(x => x.Status, HostedSiteOptimizationStatuses.Queued)
                .Set(x => x.UpdatedAt, DateTime.UtcNow)
                .Set(x => x.ExpiresAt, DateTime.UtcNow.Add(SessionLifetime)),
            cancellationToken: CancellationToken.None);
        if (update.ModifiedCount != 1)
        {
            var current = await GetOwnedSessionAsync(sessionId, userId, ct);
            if (current.Status is HostedSiteOptimizationStatuses.Queued
                or HostedSiteOptimizationStatuses.Analyzing
                or HostedSiteOptimizationStatuses.AwaitingDecision
                or HostedSiteOptimizationStatuses.Previewing
                or HostedSiteOptimizationStatuses.PreviewReady
                or HostedSiteOptimizationStatuses.Saving
                or HostedSiteOptimizationStatuses.Saved)
                return;
            throw new InvalidOperationException("这个上传任务已经结束，请重新选择文件");
        }
    }

    public async Task<HostedSiteOptimizationUploadStatusResult> GetUploadStatusAsync(
        string sessionId,
        string userId,
        CancellationToken ct = default)
    {
        var session = await GetOwnedSessionAsync(sessionId, userId, ct);
        var recoveredSite = await TryRecoverCompletedSiteAsync(session, userId, ct);
        if (recoveredSite != null)
            session = await GetOwnedSessionAsync(sessionId, userId, ct);
        HostedSite? site = null;
        if (session.Status == HostedSiteOptimizationStatuses.Saved
            && !string.IsNullOrWhiteSpace(session.CompletedSiteId))
        {
            site = await _hostedSites.GetByIdAsync(session.CompletedSiteId, userId, ct);
        }

        HostedSiteOptimizationReviewResult? review = null;
        if (session.Status is HostedSiteOptimizationStatuses.AwaitingDecision
            or HostedSiteOptimizationStatuses.PreviewReady)
        {
            review = new HostedSiteOptimizationReviewResult
            {
                Outcome = "optimization-recommended",
                SessionId = session.Id,
                ExpiresAt = session.ExpiresAt,
                Analysis = session.Analysis,
            };
        }
        else if (session.Status == HostedSiteOptimizationStatuses.Saved && site != null)
        {
            review = new HostedSiteOptimizationReviewResult
            {
                Outcome = "saved",
                Site = site,
                Analysis = session.Analysis,
            };
        }

        var uploadedBytes = session.UploadedChunkIndexes
            .Distinct()
            .Where(x => x >= 0 && x < session.TotalChunks)
            .Sum(x => x == session.TotalChunks - 1
                ? session.SourceFileSize - (long)session.ChunkSize * (session.TotalChunks - 1)
                : session.ChunkSize);
        return new HostedSiteOptimizationUploadStatusResult
        {
            SessionId = session.Id,
            Status = session.Status,
            Stage = StageFor(session.Status),
            UploadedChunks = session.UploadedChunkIndexes.Distinct().Count(),
            TotalChunks = session.TotalChunks,
            UploadedBytes = uploadedBytes,
            TotalBytes = session.SourceFileSize,
            Error = session.Error,
            Review = review,
        };
    }

    public async Task<bool> ProcessNextQueuedAsync(CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        await FailExpiredWorkerSavesAsync(now);
        var leaseOwner = Guid.NewGuid().ToString("N");
        var expiredLease = Builders<HostedSiteOptimizationSession>.Filter.Or(
            Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.LeaseExpiresAt, null),
            Builders<HostedSiteOptimizationSession>.Filter.Lt(x => x.LeaseExpiresAt, now));
        var filter = Builders<HostedSiteOptimizationSession>.Filter.Or(
            Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.Status, HostedSiteOptimizationStatuses.Queued),
            Builders<HostedSiteOptimizationSession>.Filter.And(
                Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.Status, HostedSiteOptimizationStatuses.Analyzing),
                expiredLease));
        var session = await _db.HostedSiteOptimizationSessions.FindOneAndUpdateAsync(
            filter,
            Builders<HostedSiteOptimizationSession>.Update
                .Set(x => x.Status, HostedSiteOptimizationStatuses.Analyzing)
                .Set(x => x.Error, null)
                .Set(x => x.LeaseOwner, leaseOwner)
                .Set(x => x.LeaseExpiresAt, now.Add(WorkerLeaseLifetime))
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.ExpiresAt, now.Add(SessionLifetime)),
            new FindOneAndUpdateOptions<HostedSiteOptimizationSession>
            {
                ReturnDocument = ReturnDocument.After,
                Sort = Builders<HostedSiteOptimizationSession>.Sort.Ascending(x => x.CreatedAt),
            },
            CancellationToken.None);
        if (session == null) return false;

        using var leaseCancellation = new CancellationTokenSource();
        var leaseHeartbeat = RenewWorkerLeaseAsync(session.Id, leaseOwner, leaseCancellation.Token);
        try
        {
            var sourceBytes = await DownloadChunksAsync(session);
            var analysis = Analyze(sourceBytes);
            if (analysis.Blocked)
                throw new InvalidOperationException(analysis.Error ?? "ZIP 文件无法通过安全检查，请重新导出后再试");

            if (analysis.Recommended)
            {
                session.SourceObjectKey = _storage.BuildSiteKey(StorageScope(session), "__source/source.zip");
                session.SourceSha256 = Convert.ToHexString(SHA256.HashData(sourceBytes)).ToLowerInvariant();
                var sourceRecorded = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id
                         && x.Status == HostedSiteOptimizationStatuses.Analyzing
                         && x.LeaseOwner == leaseOwner,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.SourceObjectKey, session.SourceObjectKey)
                        .Set(x => x.SourceSha256, session.SourceSha256)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow)
                        .Set(x => x.ExpiresAt, DateTime.UtcNow.Add(SessionLifetime)),
                    cancellationToken: CancellationToken.None);
                if (sourceRecorded.MatchedCount != 1) return true;
                await _storage.UploadToKeyAsync(
                    session.SourceObjectKey,
                    sourceBytes,
                    "application/zip",
                    CancellationToken.None,
                    "private, no-store");
                var transitioned = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id
                         && x.Status == HostedSiteOptimizationStatuses.Analyzing
                         && x.LeaseOwner == leaseOwner,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.SourceObjectKey, session.SourceObjectKey)
                        .Set(x => x.SourceSha256, session.SourceSha256)
                        .Set(x => x.Analysis, analysis)
                        .Set(x => x.Status, HostedSiteOptimizationStatuses.AwaitingDecision)
                        .Set(x => x.LeaseOwner, null)
                        .Set(x => x.LeaseExpiresAt, null)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow)
                        .Set(x => x.ExpiresAt, DateTime.UtcNow.Add(SessionLifetime)),
                    cancellationToken: CancellationToken.None);
                if (transitioned.ModifiedCount != 1) return true;
                await CleanupChunkFilesAsync(session);
                return true;
            }

            var saveClaim = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                x => x.Id == session.Id
                     && x.Status == HostedSiteOptimizationStatuses.Analyzing
                     && x.LeaseOwner == leaseOwner,
                Builders<HostedSiteOptimizationSession>.Update
                    .Set(x => x.Analysis, analysis)
                    .Set(x => x.Status, HostedSiteOptimizationStatuses.Saving)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            if (saveClaim.ModifiedCount != 1) return true;

            HostedSite saved;
            if (string.IsNullOrWhiteSpace(session.TargetSiteId))
            {
                saved = await _hostedSites.CreateFromZipAsync(
                    session.OwnerUserId,
                    sourceBytes,
                    session.Title,
                    session.Description,
                    session.Folder,
                    session.Tags,
                    ct: CancellationToken.None,
                    sourceRef: session.Id);
            }
            else
            {
                saved = await _hostedSites.ReuploadAsync(
                    session.TargetSiteId,
                    session.OwnerUserId,
                    sourceBytes,
                    session.SourceFileName,
                    ct: CancellationToken.None);
                var metadata = await _hostedSites.UpdateAsync(
                    saved.Id,
                    session.OwnerUserId,
                    session.Title,
                    session.Description,
                    session.Tags,
                    session.Folder,
                    coverImageUrl: null,
                    ct: CancellationToken.None);
                if (metadata != null) saved = metadata;
            }

            if (!await PersistSavedCompletionAsync(session.Id, session.OwnerUserId, saved.Id))
            {
                _logger.LogError(
                    "网页托管站点已保存但无法登记完成状态，保留分片供后续核对: {SessionId} {SiteId}",
                    session.Id,
                    saved.Id);
                return true;
            }
            await CleanupChunkFilesAsync(session);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "网页托管 ZIP 后台分析失败: {SessionId}", session.Id);
            var message = ex is InvalidOperationException
                ? ex.Message
                : "文件处理未完成，请重新上传；原文件和既有站点均未被修改";
            await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                x => x.Id == session.Id && x.LeaseOwner == leaseOwner,
                Builders<HostedSiteOptimizationSession>.Update
                    .Set(x => x.Status, HostedSiteOptimizationStatuses.Failed)
                    .Set(x => x.Error, message)
                    .Set(x => x.LeaseOwner, null)
                    .Set(x => x.LeaseExpiresAt, null)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow)
                    .Set(x => x.ExpiresAt, DateTime.UtcNow.Add(SessionLifetime)),
                cancellationToken: CancellationToken.None);
        }
        finally
        {
            leaseCancellation.Cancel();
            try
            {
                await leaseHeartbeat;
            }
            catch (OperationCanceledException)
            {
                // 正常收尾：任务已经结束，不再续租。
            }
        }
        return true;
    }

    public async Task<HostedSiteOptimizationPreviewResult> PreparePreviewAsync(
        string sessionId,
        string userId,
        CancellationToken ct = default)
    {
        var session = await GetOwnedSessionAsync(sessionId, userId, ct);
        var recoveryNow = DateTime.UtcNow;
        if (session.Status == HostedSiteOptimizationStatuses.Previewing
            && (!session.LeaseExpiresAt.HasValue || session.LeaseExpiresAt <= recoveryNow))
        {
            var recoveryOwner = Guid.NewGuid().ToString("N");
            var recoveryFilter = Builders<HostedSiteOptimizationSession>.Filter.And(
                Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.Id, session.Id),
                Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.OwnerUserId, userId),
                Builders<HostedSiteOptimizationSession>.Filter.Eq(
                    x => x.Status, HostedSiteOptimizationStatuses.Previewing),
                Builders<HostedSiteOptimizationSession>.Filter.Or(
                    Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.LeaseExpiresAt, null),
                    Builders<HostedSiteOptimizationSession>.Filter.Lte(x => x.LeaseExpiresAt, recoveryNow)));
            var recoveryClaim = await _db.HostedSiteOptimizationSessions.FindOneAndUpdateAsync(
                recoveryFilter,
                Builders<HostedSiteOptimizationSession>.Update
                    .Set(x => x.Status, HostedSiteOptimizationStatuses.CleanupPending)
                    .Set(x => x.LeaseOwner, recoveryOwner)
                    .Set(x => x.LeaseExpiresAt, recoveryNow.Add(WorkerLeaseLifetime))
                    .Set(x => x.UpdatedAt, recoveryNow),
                new FindOneAndUpdateOptions<HostedSiteOptimizationSession>
                {
                    ReturnDocument = ReturnDocument.After,
                },
                CancellationToken.None);
            if (recoveryClaim == null)
            {
                session = await GetOwnedSessionAsync(sessionId, userId, CancellationToken.None);
            }
            else if (!await CleanupPreviewFilesAsync(recoveryClaim.PreviewFiles))
            {
                await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id
                         && x.OwnerUserId == userId
                         && x.Status == HostedSiteOptimizationStatuses.CleanupPending
                         && x.LeaseOwner == recoveryOwner,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.LeaseOwner, null)
                        .Set(x => x.LeaseExpiresAt, null)
                        .Set(x => x.ExpiresAt, recoveryNow),
                    cancellationToken: CancellationToken.None);
                throw new InvalidOperationException("上次预览中断，临时文件正在清理，请稍后重试");
            }
            else
            {
                var recovered = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id
                         && x.OwnerUserId == userId
                         && x.Status == HostedSiteOptimizationStatuses.CleanupPending
                         && x.LeaseOwner == recoveryOwner,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.Status, HostedSiteOptimizationStatuses.AwaitingDecision)
                        .Set(x => x.PreviewFiles, new List<HostedSiteFile>())
                        .Set(x => x.PreviewEntryFile, null)
                        .Set(x => x.PreviewAccessToken, string.Empty)
                        .Set(x => x.PreviewTotalSize, 0)
                        .Set(x => x.LeaseOwner, null)
                        .Set(x => x.LeaseExpiresAt, null)
                        .Set(x => x.UpdatedAt, recoveryNow)
                        .Set(x => x.ExpiresAt, recoveryNow.Add(SessionLifetime)),
                    cancellationToken: CancellationToken.None);
                if (recovered.ModifiedCount != 1)
                    throw new InvalidOperationException("上次预览恢复状态已变化，请刷新后重试");
                session = await GetOwnedSessionAsync(sessionId, userId, CancellationToken.None);
            }
        }
        EnsureUsable(session);

        if (session.Status == HostedSiteOptimizationStatuses.PreviewReady
            && session.PreviewFiles.Count > 0
            && !string.IsNullOrWhiteSpace(session.PreviewEntryFile))
        {
            if (string.IsNullOrWhiteSpace(session.PreviewAccessToken))
            {
                session.PreviewAccessToken = NewSecretToken();
                await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id && x.OwnerUserId == userId,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.PreviewAccessToken, session.PreviewAccessToken),
                    cancellationToken: CancellationToken.None);
            }
            return ToPreviewResult(session);
        }

        if (session.Status != HostedSiteOptimizationStatuses.AwaitingDecision)
            throw new InvalidOperationException("当前优化任务不能生成预览，请刷新后重试");

        session.ExpiresAt = DateTime.UtcNow.Add(SessionLifetime);
        session.UpdatedAt = DateTime.UtcNow;
        var leaseOwner = Guid.NewGuid().ToString("N");
        var previewClaim = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
            x => x.Id == session.Id
                 && x.OwnerUserId == userId
                 && x.Status == HostedSiteOptimizationStatuses.AwaitingDecision,
            Builders<HostedSiteOptimizationSession>.Update
                .Set(x => x.Status, HostedSiteOptimizationStatuses.Previewing)
                .Set(x => x.LeaseOwner, leaseOwner)
                .Set(x => x.LeaseExpiresAt, DateTime.UtcNow.Add(WorkerLeaseLifetime))
                .Set(x => x.ExpiresAt, session.ExpiresAt)
                .Set(x => x.UpdatedAt, session.UpdatedAt),
            cancellationToken: CancellationToken.None);
        if (previewClaim.ModifiedCount != 1)
            throw new InvalidOperationException("优化任务状态已变化，请刷新后查看最新结果");
        session.Status = HostedSiteOptimizationStatuses.Previewing;

        var uploaded = new List<HostedSiteFile>();
        using var leaseCancellation = new CancellationTokenSource();
        var leaseHeartbeat = RenewWorkerLeaseAsync(session.Id, leaseOwner, leaseCancellation.Token);
        try
        {
            var sourceBytes = await _storage.TryDownloadBytesAsync(
                                  session.SourceObjectKey, CancellationToken.None)
                              ?? throw new InvalidOperationException("临时源文件已经过期，请重新选择文件");
            var sourceSha = Convert.ToHexString(SHA256.HashData(sourceBytes)).ToLowerInvariant();
            if (!string.Equals(sourceSha, session.SourceSha256, StringComparison.Ordinal))
                throw new InvalidOperationException("临时源文件校验失败，请重新选择文件");

            var build = BuildOptimizedPackage(sourceBytes);
            if (build.Analysis.Blocked || !build.Analysis.Recommended || build.Files.Count == 0)
                throw new InvalidOperationException(build.Analysis.Error ?? "当前文件无法安全自动优化，请保留原文件");

            foreach (var (path, bytes) in build.Files.OrderBy(x => x.Key, StringComparer.Ordinal))
            {
                var key = _storage.BuildSiteKey(StorageScope(session), $"__preview/{path}");
                var mime = MimeFor(path);
                var pendingFile = new HostedSiteFile
                {
                    Path = path,
                    CosKey = key,
                    Size = bytes.Length,
                    MimeType = mime,
                };
                uploaded.Add(pendingFile);
                var registered = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id
                         && x.OwnerUserId == userId
                         && x.Status == HostedSiteOptimizationStatuses.Previewing
                         && x.LeaseOwner == leaseOwner,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Push(x => x.PreviewFiles, pendingFile)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
                if (registered.ModifiedCount != 1)
                    throw new InvalidOperationException("优化任务状态已变化，未继续生成预览");
                await _storage.UploadToKeyAsync(
                    key,
                    bytes,
                    mime == "text/html" ? "text/html; charset=utf-8" : mime,
                    CancellationToken.None,
                    "private, no-store");
            }

            var totalSize = uploaded.Sum(x => x.Size);
            var manifestError = HostedSiteService.ValidateZipManifestSize(uploaded);
            if (manifestError != null)
                throw new InvalidOperationException(manifestError);

            session.PreviewFiles = uploaded;
            session.PreviewEntryFile = build.EntryFile;
            session.PreviewAccessToken = NewSecretToken();
            session.PreviewTotalSize = totalSize;
            session.Analysis = build.Analysis;
            session.UpdatedAt = DateTime.UtcNow;

            var completed = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                x => x.Id == session.Id
                     && x.OwnerUserId == userId
                     && x.Status == HostedSiteOptimizationStatuses.Previewing
                     && x.LeaseOwner == leaseOwner,
                Builders<HostedSiteOptimizationSession>.Update
                    .Set(x => x.PreviewFiles, session.PreviewFiles)
                    .Set(x => x.PreviewEntryFile, session.PreviewEntryFile)
                    .Set(x => x.PreviewAccessToken, session.PreviewAccessToken)
                    .Set(x => x.PreviewTotalSize, session.PreviewTotalSize)
                    .Set(x => x.Analysis, session.Analysis)
                    .Set(x => x.Status, HostedSiteOptimizationStatuses.PreviewReady)
                    .Set(x => x.LeaseOwner, null)
                    .Set(x => x.LeaseExpiresAt, null)
                    .Set(x => x.UpdatedAt, session.UpdatedAt)
                    .Set(x => x.ExpiresAt, DateTime.UtcNow.Add(SessionLifetime)),
                cancellationToken: CancellationToken.None);
            if (completed.ModifiedCount != 1)
                throw new InvalidOperationException("优化任务状态已变化，未保存本次预览");
            session.Status = HostedSiteOptimizationStatuses.PreviewReady;
            return ToPreviewResult(session);
        }
        catch
        {
            var cleaned = await CleanupPreviewFilesAsync(uploaded);
            if (cleaned)
            {
                await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id
                         && x.OwnerUserId == userId
                         && x.Status == HostedSiteOptimizationStatuses.Previewing
                         && x.LeaseOwner == leaseOwner,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.Status, HostedSiteOptimizationStatuses.AwaitingDecision)
                        .Set(x => x.PreviewFiles, new List<HostedSiteFile>())
                        .Set(x => x.LeaseOwner, null)
                        .Set(x => x.LeaseExpiresAt, null)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow)
                        .Set(x => x.ExpiresAt, DateTime.UtcNow.Add(SessionLifetime)),
                    cancellationToken: CancellationToken.None);
            }
            else
            {
                await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id
                         && x.OwnerUserId == userId
                         && x.Status == HostedSiteOptimizationStatuses.Previewing
                         && x.LeaseOwner == leaseOwner,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.Status, HostedSiteOptimizationStatuses.CleanupPending)
                        .Set(x => x.PreviewFiles, uploaded)
                        .Set(x => x.LeaseOwner, null)
                        .Set(x => x.LeaseExpiresAt, null)
                        .Set(x => x.ExpiresAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
            }
            throw;
        }
        finally
        {
            leaseCancellation.Cancel();
            try
            {
                await leaseHeartbeat;
            }
            catch (OperationCanceledException)
            {
                // 正常收尾：预览任务已经结束，不再续租。
            }
        }
    }

    public async Task<HostedSite> ConfirmAsync(
        string sessionId,
        string userId,
        string variant,
        CancellationToken ct = default)
    {
        var normalizedVariant = (variant ?? string.Empty).Trim().ToLowerInvariant();
        if (normalizedVariant is not ("original" or "optimized"))
            throw new InvalidOperationException("请选择保存原文件或优化版本");

        var session = await GetOwnedSessionAsync(sessionId, userId, ct);
        if (session.Status == HostedSiteOptimizationStatuses.Saved
            && !string.IsNullOrWhiteSpace(session.CompletedSiteId))
        {
            return await _hostedSites.GetByIdAsync(
                       session.CompletedSiteId, userId, CancellationToken.None)
                   ?? throw new InvalidOperationException("文件已经保存，但站点暂时无法读取，请刷新站点列表");
        }
        var recoveredSite = await TryRecoverCompletedSiteAsync(session, userId, ct);
        if (recoveredSite != null) return recoveredSite;
        EnsureUsable(session);
        if (normalizedVariant == "optimized"
            && (session.Status != HostedSiteOptimizationStatuses.PreviewReady || session.PreviewFiles.Count == 0))
            throw new InvalidOperationException("请先查看优化版本，再决定是否保存");

        var previousStatus = session.Status;
        var leaseOwner = Guid.NewGuid().ToString("N");
        var now = DateTime.UtcNow;
        var claim = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
            x => x.Id == session.Id
                 && x.OwnerUserId == userId
                 && x.Status == previousStatus
                 && x.ExpiresAt > now,
            Builders<HostedSiteOptimizationSession>.Update
                .Set(x => x.Status, HostedSiteOptimizationStatuses.Saving)
                .Set(x => x.LeaseOwner, leaseOwner)
                .Set(x => x.LeaseExpiresAt, now.Add(WorkerLeaseLifetime))
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.ExpiresAt, now.Add(SessionLifetime)),
            cancellationToken: CancellationToken.None);
        if (claim.ModifiedCount != 1)
            throw new InvalidOperationException("这个优化任务正在保存或已经过期，请刷新后重试");

        using var leaseCancellation = new CancellationTokenSource();
        var leaseHeartbeat = RenewWorkerLeaseAsync(session.Id, leaseOwner, leaseCancellation.Token);
        try
        {
            HostedSite saved;
            try
            {
                var zipBytes = normalizedVariant == "original"
                    ? await _storage.TryDownloadBytesAsync(session.SourceObjectKey, CancellationToken.None)
                    : await BuildZipFromPreviewAsync(session, CancellationToken.None);
                if (zipBytes == null || zipBytes.Length == 0)
                    throw new InvalidOperationException("临时文件已经过期，请重新选择文件");

                if (string.IsNullOrWhiteSpace(session.TargetSiteId))
                {
                    saved = await _hostedSites.CreateFromZipAsync(
                        userId,
                        zipBytes,
                        session.Title,
                        session.Description,
                        session.Folder,
                        session.Tags,
                        ct: CancellationToken.None,
                        sourceRef: session.Id);
                }
                else
                {
                    saved = await _hostedSites.ReuploadAsync(
                        session.TargetSiteId,
                        userId,
                        zipBytes,
                        session.SourceFileName,
                        ct: CancellationToken.None);
                    var metadata = await _hostedSites.UpdateAsync(
                        saved.Id,
                        userId,
                        session.Title,
                        session.Description,
                        session.Tags,
                        session.Folder,
                        coverImageUrl: null,
                        ct: CancellationToken.None);
                    if (metadata != null) saved = metadata;
                }
            }
            catch
            {
                await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id && x.OwnerUserId == userId && x.LeaseOwner == leaseOwner,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.Status, previousStatus)
                        .Set(x => x.LeaseOwner, null)
                        .Set(x => x.LeaseExpiresAt, null)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow)
                        .Set(x => x.ExpiresAt, DateTime.UtcNow.Add(SessionLifetime)),
                    cancellationToken: CancellationToken.None);
                throw;
            }

            // 从这里开始正式站点已经保存成功，后续清理异常不能再把状态恢复成可确认，
            // 否则客户端重试会重复创建站点。先固化完成身份，再做不影响结果的清理。
            if (!await PersistSavedCompletionAsync(session.Id, userId, saved.Id))
            {
                _logger.LogError(
                    "网页托管站点已保存但无法登记确认结果，保留临时文件供恢复: {SessionId} {SiteId}",
                    session.Id,
                    saved.Id);
                throw new InvalidOperationException("站点已保存，正在登记结果，请刷新站点列表后重试");
            }

            session.Status = HostedSiteOptimizationStatuses.Saved;
            session.CompletedSiteId = saved.Id;

            if (await CleanupSessionFilesAsync(session))
            {
                await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id
                         && x.OwnerUserId == userId
                         && x.Status == HostedSiteOptimizationStatuses.Saved,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.SourceObjectKey, string.Empty)
                        .Set(x => x.PreviewFiles, new List<HostedSiteFile>()),
                    cancellationToken: CancellationToken.None);
            }
            return saved;
        }
        finally
        {
            leaseCancellation.Cancel();
            try
            {
                await leaseHeartbeat;
            }
            catch (OperationCanceledException)
            {
                // 正常收尾：确认请求已经结束，不再续租。
            }
        }
    }

    public async Task CancelAsync(string sessionId, string userId, CancellationToken ct = default)
    {
        var session = await _db.HostedSiteOptimizationSessions
            .Find(x => x.Id == sessionId && x.OwnerUserId == userId)
            .FirstOrDefaultAsync(ct);
        if (session == null) return;
        if (session.Status is HostedSiteOptimizationStatuses.Analyzing
            or HostedSiteOptimizationStatuses.Previewing
            or HostedSiteOptimizationStatuses.Saving)
            throw new InvalidOperationException("文件正在后台处理，请等待当前步骤完成");

        var cleanupAfter = DateTime.UtcNow.Add(WorkerLeaseLifetime);
        var claim = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
            Builders<HostedSiteOptimizationSession>.Filter.And(
                Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.Id, session.Id),
                Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.OwnerUserId, userId),
                Builders<HostedSiteOptimizationSession>.Filter.Nin(
                    x => x.Status,
                    new[]
                    {
                        HostedSiteOptimizationStatuses.Analyzing,
                        HostedSiteOptimizationStatuses.Previewing,
                        HostedSiteOptimizationStatuses.Saving,
                    })),
            Builders<HostedSiteOptimizationSession>.Update
                .Set(x => x.Status, HostedSiteOptimizationStatuses.CleanupPending)
                .Set(x => x.ExpiresAt, cleanupAfter)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        if (claim.MatchedCount == 0)
            throw new InvalidOperationException("文件正在后台处理，请等待当前步骤完成");

        // 保留取消墓碑一个完整租约周期。已经开始的分片写入即使晚于取消落盘，
        // 也仍有会话账本可供周期清理收敛，不会成为永久孤儿对象。
        session.Status = HostedSiteOptimizationStatuses.CleanupPending;
        session.ExpiresAt = cleanupAfter;
    }

    public async Task<HostedSiteOptimizationQueueHealth> GetQueueHealthAsync(CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var queued = await _db.HostedSiteOptimizationSessions
            .Find(x => x.Status == HostedSiteOptimizationStatuses.Queued)
            .SortBy(x => x.CreatedAt)
            .Limit(QueueBacklogThreshold + 1)
            .ToListAsync(ct);
        var holders = await _db.HostedSiteOptimizationSessions
            .Find(x => x.Status == HostedSiteOptimizationStatuses.Analyzing
                       || x.Status == HostedSiteOptimizationStatuses.Previewing
                       || x.Status == HostedSiteOptimizationStatuses.Saving)
            .SortBy(x => x.UpdatedAt)
            .Limit(100)
            .ToListAsync(ct);
        var oldestQueuedAt = queued.FirstOrDefault()?.CreatedAt;
        var oldestAge = oldestQueuedAt.HasValue ? now - oldestQueuedAt.Value : (TimeSpan?)null;
        var expiredHolderCount = holders.Count(x => x.LeaseExpiresAt.HasValue && x.LeaseExpiresAt <= now);
        var healthy = IsQueueHealthy(queued.Count, oldestAge, expiredHolderCount);
        return new HostedSiteOptimizationQueueHealth
        {
            Healthy = healthy,
            QueuedCount = queued.Count,
            ActiveCount = holders.Count,
            ExpiredHolderCount = expiredHolderCount,
            OldestQueuedAt = oldestQueuedAt,
            HolderSessionIds = holders.Select(x => x.Id).ToList(),
            QueuedSessionIds = queued.Take(20).Select(x => x.Id).ToList(),
            Message = healthy
                ? "网页托管优化队列正常"
                : "网页托管优化队列积压或持有者租约异常，请检查后台任务",
        };
    }

    internal static bool IsQueueHealthy(int queuedCount, TimeSpan? oldestQueueAge, int expiredHolderCount)
        => queuedCount <= QueueBacklogThreshold
           && expiredHolderCount == 0
           && (!oldestQueueAge.HasValue || oldestQueueAge < QueueStallThreshold);

    public async Task<(int Selected, int Deleted)> CleanupExpiredAsync(CancellationToken ct = default)
    {
        var cleanupNow = DateTime.UtcNow;
        var expired = await _db.HostedSiteOptimizationSessions
            .Find(x => x.ExpiresAt <= cleanupNow)
            .Limit(20)
            .ToListAsync(ct);
        var cleanedCount = 0;
        foreach (var session in expired)
        {
            var cleanupOwner = Guid.NewGuid().ToString("N");
            var claimFilter = Builders<HostedSiteOptimizationSession>.Filter.And(
                Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.Id, session.Id),
                Builders<HostedSiteOptimizationSession>.Filter.Lte(x => x.ExpiresAt, cleanupNow));
            var claimed = await _db.HostedSiteOptimizationSessions.FindOneAndUpdateAsync(
                claimFilter,
                Builders<HostedSiteOptimizationSession>.Update
                    .Set(x => x.Status, HostedSiteOptimizationStatuses.CleanupPending)
                    .Set(x => x.LeaseOwner, cleanupOwner)
                    .Set(x => x.LeaseExpiresAt, cleanupNow.Add(WorkerLeaseLifetime))
                    .Set(x => x.ExpiresAt, cleanupNow.Add(WorkerLeaseLifetime))
                    .Set(x => x.UpdatedAt, cleanupNow),
                new FindOneAndUpdateOptions<HostedSiteOptimizationSession>
                {
                    ReturnDocument = ReturnDocument.After,
                },
                CancellationToken.None);
            if (claimed == null) continue;
            if (await CleanupSessionFilesAsync(claimed))
            {
                var deleted = await _db.HostedSiteOptimizationSessions.DeleteOneAsync(
                    x => x.Id == session.Id
                         && x.Status == HostedSiteOptimizationStatuses.CleanupPending
                         && x.LeaseOwner == cleanupOwner,
                    ct);
                if (deleted.DeletedCount == 1) cleanedCount++;
            }
            else
            {
                await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    x => x.Id == session.Id
                         && x.Status == HostedSiteOptimizationStatuses.CleanupPending
                         && x.LeaseOwner == cleanupOwner,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.LeaseOwner, null)
                        .Set(x => x.LeaseExpiresAt, null)
                        .Set(x => x.ExpiresAt, cleanupNow.Add(CleanupRetryDelay)),
                    cancellationToken: CancellationToken.None);
            }
        }
        return (expired.Count, cleanedCount);
    }

    private async Task<HostedSiteOptimizationSession> GetOwnedSessionAsync(
        string sessionId,
        string userId,
        CancellationToken ct)
        => await _db.HostedSiteOptimizationSessions
               .Find(x => x.Id == sessionId && x.OwnerUserId == userId)
               .FirstOrDefaultAsync(ct)
           ?? throw new KeyNotFoundException("优化任务不存在或已经过期");

    private async Task<HostedSite?> TryRecoverCompletedSiteAsync(
        HostedSiteOptimizationSession session,
        string userId,
        CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(session.CompletedSiteId)
            || !string.IsNullOrWhiteSpace(session.TargetSiteId)
            || session.Status is not (HostedSiteOptimizationStatuses.Saving or HostedSiteOptimizationStatuses.Failed))
            return null;

        var persisted = await _db.HostedSites
            .Find(x => x.OwnerUserId == userId
                       && x.SourceType == "upload"
                       && x.SourceRef == session.Id)
            .SortByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);
        if (persisted == null) return null;
        if (!await PersistSavedCompletionAsync(session.Id, userId, persisted.Id))
            throw new InvalidOperationException("站点已保存，正在恢复任务状态，请稍后重试");
        return await _hostedSites.GetByIdAsync(persisted.Id, userId, ct) ?? persisted;
    }

    private async Task<bool> PersistSavedCompletionAsync(string sessionId, string userId, string siteId)
    {
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                var filter = Builders<HostedSiteOptimizationSession>.Filter.And(
                    Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.Id, sessionId),
                    Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.OwnerUserId, userId),
                    Builders<HostedSiteOptimizationSession>.Filter.In(
                        x => x.Status,
                        new[]
                        {
                            HostedSiteOptimizationStatuses.Saving,
                            HostedSiteOptimizationStatuses.Failed,
                            HostedSiteOptimizationStatuses.Saved,
                        }),
                    Builders<HostedSiteOptimizationSession>.Filter.Or(
                        Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.CompletedSiteId, null),
                        Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.CompletedSiteId, siteId)));
                var result = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                    filter,
                    Builders<HostedSiteOptimizationSession>.Update
                        .Set(x => x.CompletedSiteId, siteId)
                        .Set(x => x.Status, HostedSiteOptimizationStatuses.Saved)
                        .Set(x => x.Error, null)
                        .Set(x => x.LeaseOwner, null)
                        .Set(x => x.LeaseExpiresAt, null)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow)
                        .Set(x => x.ExpiresAt, DateTime.UtcNow.AddMinutes(10)),
                    cancellationToken: CancellationToken.None);
                return result.MatchedCount == 1;
            }
            catch (Exception ex) when (attempt < 3)
            {
                _logger.LogWarning(
                    ex,
                    "网页托管完成状态登记失败，准备重试: {SessionId} {Attempt}",
                    sessionId,
                    attempt);
                await Task.Delay(TimeSpan.FromMilliseconds(50 * attempt), CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "网页托管完成状态登记连续失败: {SessionId}", sessionId);
                return false;
            }
        }
        return false;
    }

    private static void EnsureUsable(HostedSiteOptimizationSession session)
    {
        if (session.ExpiresAt <= DateTime.UtcNow)
            throw new InvalidOperationException("优化任务已经过期，请重新选择文件");
        if (session.Status == HostedSiteOptimizationStatuses.Saving)
            throw new InvalidOperationException("优化版本正在保存，请稍后查看结果");
        if (session.Status == HostedSiteOptimizationStatuses.Previewing)
            throw new InvalidOperationException("正在生成优化预览，请稍后再试");
        if (session.Status == HostedSiteOptimizationStatuses.CleanupPending)
            throw new InvalidOperationException("这个优化任务已经结束，请刷新站点列表查看结果");
        if (session.Status is HostedSiteOptimizationStatuses.Uploading
            or HostedSiteOptimizationStatuses.Queued
            or HostedSiteOptimizationStatuses.Analyzing)
            throw new InvalidOperationException("文件仍在后台分析，请稍后再试");
        if (session.Status == HostedSiteOptimizationStatuses.Failed)
            throw new InvalidOperationException(session.Error ?? "文件处理未完成，请重新上传");
    }

    private HostedSiteOptimizationPreviewResult ToPreviewResult(HostedSiteOptimizationSession session)
    {
        var entry = session.PreviewFiles.FirstOrDefault(
            x => string.Equals(x.Path, session.PreviewEntryFile, StringComparison.OrdinalIgnoreCase));
        if (entry == null) throw new InvalidOperationException("优化版本缺少入口文件，请重新优化");
        return new HostedSiteOptimizationPreviewResult
        {
            SessionId = session.Id,
            PreviewUrl = BuildPreviewProxyUrl(session, entry.Path),
            EntryFile = entry.Path,
            FileCount = session.PreviewFiles.Count,
            TotalSize = session.PreviewTotalSize,
            ExpiresAt = session.ExpiresAt,
            Analysis = session.Analysis,
        };
    }

    public async Task<HostedSiteOptimizationPreviewFileResult?> GetPreviewFileAsync(
        string sessionId,
        string accessToken,
        string filePath,
        CancellationToken ct = default)
    {
        var session = await _db.HostedSiteOptimizationSessions
            .Find(x => x.Id == sessionId
                       && x.Status == HostedSiteOptimizationStatuses.PreviewReady
                       && x.ExpiresAt > DateTime.UtcNow)
            .FirstOrDefaultAsync(ct);
        if (session == null || !SecretEquals(session.PreviewAccessToken, accessToken)) return null;

        var normalized = NormalizePath(Uri.UnescapeDataString(filePath ?? string.Empty)).TrimStart('/');
        if (string.IsNullOrWhiteSpace(normalized) || IsUnsafePath(normalized)) return null;
        var file = session.PreviewFiles.FirstOrDefault(
            x => string.Equals(x.Path, normalized, StringComparison.Ordinal));
        if (file == null) return null;
        var bytes = await _storage.TryDownloadBytesAsync(file.CosKey, ct);
        if (bytes != null)
            bytes = RewriteRootReferencesForPreview(
                bytes, file.MimeType, BuildPreviewProxyBase(session), normalized);
        return bytes == null
            ? null
            : new HostedSiteOptimizationPreviewFileResult
            {
                Bytes = bytes,
                MimeType = file.MimeType,
            };
    }

    internal static string BuildPreviewProxyUrl(HostedSiteOptimizationSession session, string filePath)
    {
        var escapedPath = string.Join("/", NormalizePath(filePath).Split('/').Select(Uri.EscapeDataString));
        return BuildPreviewProxyBase(session) + escapedPath;
    }

    private static string BuildPreviewProxyBase(HostedSiteOptimizationSession session)
        => $"/api/web-pages/optimization/{Uri.EscapeDataString(session.Id)}/preview-content/"
           + $"{Uri.EscapeDataString(session.PreviewAccessToken)}/";

    internal static byte[] RewriteRootReferencesForPreview(
        byte[] bytes,
        string mimeType,
        string proxyBase,
        string ownerPath)
    {
        if (!mimeType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase)
            && !mimeType.StartsWith("text/css", StringComparison.OrdinalIgnoreCase)
            && !mimeType.Contains("javascript", StringComparison.OrdinalIgnoreCase))
            return bytes;

        if (!TryDecodeUtf8(bytes, out var text)) return bytes;
        if (mimeType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase))
        {
            text = HtmlBaseHrefRegex().Replace(text, match =>
            {
                var href = match.Groups["path"].Value;
                if (IsIgnoredReference(href) || IsExternalReference(href)) return match.Value;
                var basePath = href.Split('?', '#')[0].Trim().Replace('\\', '/');
                if (string.IsNullOrWhiteSpace(basePath)) return match.Value;
                const string directoryMarker = "__preview_base__.html";
                var resolved = basePath.EndsWith("/", StringComparison.Ordinal)
                    ? ResolveReference(ownerPath, basePath + directoryMarker)
                    : ResolveReference(ownerPath, basePath);
                if (string.IsNullOrWhiteSpace(resolved)) return match.Value;
                if (resolved.EndsWith(directoryMarker, StringComparison.Ordinal))
                    resolved = resolved[..^directoryMarker.Length];
                var escaped = string.Join('/', resolved.Split('/').Select(Uri.EscapeDataString));
                var pathGroup = match.Groups["path"];
                var relativeIndex = pathGroup.Index - match.Index;
                return match.Value[..relativeIndex] + proxyBase + escaped
                       + match.Value[(relativeIndex + pathGroup.Length)..];
            });
            var htmlWithRewrittenBase = text;
            text = Regex.Replace(
                htmlWithRewrittenBase,
                "(?<prefix>\\b(?:src|href|poster|data)\\s*=\\s*[\\\"'])/(?!/)",
                match =>
                {
                    var tagStart = htmlWithRewrittenBase.LastIndexOf('<', match.Index);
                    var tagEnd = htmlWithRewrittenBase.LastIndexOf('>', match.Index);
                    if (tagStart > tagEnd
                        && Regex.IsMatch(
                            htmlWithRewrittenBase[(tagStart + 1)..match.Index],
                            "^\\s*base\\b",
                            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
                        return match.Value;
                    return match.Groups["prefix"].Value + proxyBase;
                },
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        }
        else if (mimeType.StartsWith("text/css", StringComparison.OrdinalIgnoreCase))
        {
            text = Regex.Replace(
                text,
                "(?<prefix>(?:url\\(\\s*|@import\\s+)[\\\"']?)/(?!/)",
                match => match.Groups["prefix"].Value + proxyBase,
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        }
        else
        {
            text = Regex.Replace(
                text,
                "(?<prefix>(?:from\\s+|import\\s*(?:\\(\\s*)?|require\\s*\\(\\s*|fetch\\s*\\(\\s*|new\\s+(?:Shared)?Worker\\s*\\(\\s*|navigator\\.serviceWorker\\.register\\s*\\(\\s*|importScripts\\s*\\(\\s*)[\\\"'])/(?!/)",
                match => match.Groups["prefix"].Value + proxyBase,
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        }
        return Encoding.UTF8.GetBytes(text);
    }

    internal static byte[] RewriteRootReferencesForArtifact(byte[] bytes, string mimeType, string ownerPath)
    {
        if (!mimeType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase)
            && !mimeType.StartsWith("text/css", StringComparison.OrdinalIgnoreCase)
            && !mimeType.Contains("javascript", StringComparison.OrdinalIgnoreCase))
            return bytes;

        if (!TryDecodeUtf8(bytes, out var text)) return bytes;
        string Rewrite(Match match)
        {
            var target = match.Groups["path"].Value;
            return match.Groups["prefix"].Value + RelativeReference(ownerPath, target.TrimStart('/'));
        }

        if (mimeType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase))
        {
            text = Regex.Replace(
                text,
                "(?<prefix>\\b(?:src|href|poster|data)\\s*=\\s*[\\\"'])(?<path>/(?!/)[^\\\"']*)",
                Rewrite,
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        }
        else if (mimeType.StartsWith("text/css", StringComparison.OrdinalIgnoreCase))
        {
            text = Regex.Replace(
                text,
                "(?<prefix>(?:url\\(\\s*|@import\\s+)[\\\"']?)(?<path>/(?!/)[^\\)\\\"']*)",
                Rewrite,
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        }
        else
        {
            text = Regex.Replace(
                text,
                "(?<prefix>(?:from\\s+|import\\s*(?:\\(\\s*)?|require\\s*\\(\\s*|fetch\\s*\\(\\s*|new\\s+(?:Shared)?Worker\\s*\\(\\s*|navigator\\.serviceWorker\\.register\\s*\\(\\s*|importScripts\\s*\\(\\s*)[\\\"'])(?<path>/(?!/)[^\\\"']*)",
                Rewrite,
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        }
        return Encoding.UTF8.GetBytes(text);
    }

    internal static bool SecretEquals(string expected, string supplied)
    {
        if (string.IsNullOrWhiteSpace(expected) || string.IsNullOrWhiteSpace(supplied)) return false;
        var expectedBytes = Encoding.UTF8.GetBytes(expected);
        var suppliedBytes = Encoding.UTF8.GetBytes(supplied);
        return expectedBytes.Length == suppliedBytes.Length
               && CryptographicOperations.FixedTimeEquals(expectedBytes, suppliedBytes);
    }

    private async Task<byte[]?> BuildZipFromPreviewAsync(
        HostedSiteOptimizationSession session,
        CancellationToken ct)
    {
        using var output = new MemoryStream();
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var file in session.PreviewFiles.OrderBy(x => x.Path, StringComparer.Ordinal))
            {
                var bytes = await _storage.TryDownloadBytesAsync(file.CosKey, ct);
                if (bytes == null) return null;
                var entry = archive.CreateEntry(file.Path, CompressionLevel.Optimal);
                await using var stream = entry.Open();
                await stream.WriteAsync(bytes, ct);
            }
        }
        return output.ToArray();
    }

    private async Task<byte[]> DownloadChunksAsync(HostedSiteOptimizationSession session)
    {
        var sourceBytes = new byte[checked((int)session.SourceFileSize)];
        var offset = 0;
        for (var index = 0; index < session.TotalChunks; index++)
        {
            var chunk = await _storage.TryDownloadBytesAsync(
                            BuildChunkKey(session, index), CancellationToken.None)
                        ?? throw new InvalidOperationException("临时上传分片已经过期，请重新选择文件");
            if (chunk.Length > sourceBytes.Length - offset)
                throw new InvalidOperationException("上传文件校验失败，请重新选择文件");
            Buffer.BlockCopy(chunk, 0, sourceBytes, offset, chunk.Length);
            offset += chunk.Length;
        }
        if (offset != sourceBytes.Length)
            throw new InvalidOperationException("上传文件校验失败，请重新选择文件");
        return sourceBytes;
    }

    private async Task<bool> CleanupSessionFilesAsync(HostedSiteOptimizationSession session)
    {
        var cleaned = await TryDeleteAsync(session.SourceObjectKey);
        for (var index = 0; index < session.TotalChunks; index++)
            cleaned = await TryDeleteAsync(BuildChunkKey(session, index)) && cleaned;
        foreach (var file in session.PreviewFiles)
            cleaned = await TryDeleteAsync(file.CosKey) && cleaned;
        return cleaned;
    }

    private async Task<bool> CleanupPreviewFilesAsync(IEnumerable<HostedSiteFile> files)
    {
        var cleaned = true;
        foreach (var file in files)
            cleaned = await TryDeleteAsync(file.CosKey) && cleaned;
        return cleaned;
    }

    private async Task CleanupChunkFilesAsync(HostedSiteOptimizationSession session)
    {
        for (var index = 0; index < session.TotalChunks; index++)
            await TryDeleteAsync(BuildChunkKey(session, index));
    }

    private string BuildChunkKey(HostedSiteOptimizationSession session, int chunkIndex)
        => _storage.BuildSiteKey(StorageScope(session), $"__chunks/{chunkIndex:D6}.part");

    internal static string StorageScope(HostedSiteOptimizationSession session)
        => string.IsNullOrWhiteSpace(session.TemporaryStorageId) ? session.Id : session.TemporaryStorageId;

    private static string NewSecretToken()
        => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

    private async Task RenewWorkerLeaseAsync(
        string sessionId,
        string leaseOwner,
        CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(WorkerLeaseHeartbeat);
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            var now = DateTime.UtcNow;
            var renewed = await _db.HostedSiteOptimizationSessions.UpdateOneAsync(
                Builders<HostedSiteOptimizationSession>.Filter.And(
                    Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.Id, sessionId),
                    Builders<HostedSiteOptimizationSession>.Filter.Eq(x => x.LeaseOwner, leaseOwner),
                    Builders<HostedSiteOptimizationSession>.Filter.In(
                        x => x.Status,
                        new[]
                        {
                            HostedSiteOptimizationStatuses.Analyzing,
                            HostedSiteOptimizationStatuses.Previewing,
                            HostedSiteOptimizationStatuses.Saving,
                        })),
                Builders<HostedSiteOptimizationSession>.Update
                    .Set(x => x.LeaseExpiresAt, now.Add(WorkerLeaseLifetime))
                    .Set(x => x.UpdatedAt, now)
                    .Set(x => x.ExpiresAt, now.Add(SessionLifetime)),
                cancellationToken: CancellationToken.None);
            if (renewed.MatchedCount == 0) return;
        }
    }

    private async Task FailExpiredWorkerSavesAsync(DateTime now)
    {
        await _db.HostedSiteOptimizationSessions.UpdateManyAsync(
            Builders<HostedSiteOptimizationSession>.Filter.And(
                Builders<HostedSiteOptimizationSession>.Filter.Eq(
                    x => x.Status, HostedSiteOptimizationStatuses.Saving),
                Builders<HostedSiteOptimizationSession>.Filter.Ne(x => x.LeaseOwner, null),
                Builders<HostedSiteOptimizationSession>.Filter.Lt(x => x.LeaseExpiresAt, now)),
            Builders<HostedSiteOptimizationSession>.Update
                .Set(x => x.Status, HostedSiteOptimizationStatuses.Failed)
                .Set(x => x.Error, "保存进程意外中断，请先刷新站点列表；如果未出现新站点，请重新上传")
                .Set(x => x.LeaseOwner, null)
                .Set(x => x.LeaseExpiresAt, null)
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.ExpiresAt, now.Add(SessionLifetime)),
            cancellationToken: CancellationToken.None);
    }

    private static string StageFor(string status) => status switch
    {
        HostedSiteOptimizationStatuses.Uploading => "正在分片上传",
        HostedSiteOptimizationStatuses.Queued => "文件已送达，等待安全检查",
        HostedSiteOptimizationStatuses.Analyzing => "正在检查文件结构与可安全精简内容",
        HostedSiteOptimizationStatuses.Previewing => "正在生成优化预览",
        HostedSiteOptimizationStatuses.Saving => "检查完成，正在保存原文件",
        HostedSiteOptimizationStatuses.AwaitingDecision => "发现可安全精简的内容，等待确认",
        HostedSiteOptimizationStatuses.PreviewReady => "优化预览已经生成",
        HostedSiteOptimizationStatuses.Saved => "文件已保存",
        HostedSiteOptimizationStatuses.Failed => "文件处理未完成",
        _ => "正在收尾",
    };

    private async Task<bool> TryDeleteAsync(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return true;
        try
        {
            await _storage.DeleteByKeyAsync(key, CancellationToken.None);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "清理网页托管优化临时对象失败: {Key}", key);
            return false;
        }
    }

    private sealed class OptimizedBuild
    {
        public HostedSiteOptimizationAnalysis Analysis { get; init; } = new();
        public Dictionary<string, byte[]> Files { get; init; } = new(StringComparer.Ordinal);
        public string EntryFile { get; init; } = string.Empty;
    }

    private sealed record ArchiveFile(ZipArchiveEntry Entry, string LogicalPath);

    private OptimizedBuild BuildOptimizedPackage(byte[] zipBytes)
    {
        var analysis = new HostedSiteOptimizationAnalysis { OriginalArchiveBytes = zipBytes.LongLength };
        try
        {
            using var input = new MemoryStream(zipBytes, writable: false);
            using var archive = new ZipArchive(input, ZipArchiveMode.Read);
            analysis.OriginalEntries = archive.Entries.Count;
            if (archive.Entries.Count > MaxArchiveEntries)
                return Blocked(analysis, $"ZIP 文件超过 {MaxArchiveEntries} 项，请先在本地导出运行包");

            var rawNames = archive.Entries.Select(x => NormalizePath(x.FullName)).ToList();
            if (rawNames.Any(IsUnsafePath))
                return Blocked(analysis, "ZIP 包含不安全路径，未进行优化");
            if (rawNames.GroupBy(x => x, StringComparer.Ordinal).Any(x => x.Count() > 1))
                return Blocked(analysis, "ZIP 包含重复路径，无法确定应保留哪个文件");
            if (rawNames.Where(x => !string.IsNullOrEmpty(x))
                .GroupBy(x => x, StringComparer.OrdinalIgnoreCase).Any(x => x.Select(y => y).Distinct(StringComparer.Ordinal).Count() > 1))
                return Blocked(analysis, "ZIP 包含仅大小写不同的路径，跨平台发布可能覆盖文件");

            var prefix = DetectRootPrefix(archive.Entries);
            var files = archive.Entries
                .Where(x => !string.IsNullOrEmpty(x.Name))
                .Select(x => new ArchiveFile(x, StripRoot(NormalizePath(x.FullName), prefix)))
                .ToList();
            analysis.OriginalFiles = files.Count;
            analysis.OriginalUncompressedBytes = files.Sum(x => x.Entry.Length);
            if (analysis.OriginalUncompressedBytes > MaxUncompressedBytes)
                return Blocked(analysis, "ZIP 解压后超过 500 MB，未进行优化");
            if (analysis.OriginalUncompressedBytes > MaxOptimizationBytes)
            {
                analysis.Warnings.Add("文件解压后超过 200 MB，本次跳过自动优化并按原文件保存");
                return new OptimizedBuild { Analysis = analysis };
            }
            if (files.Any(x => x.Entry.CompressedLength > 0
                               && x.Entry.Length > 1024 * 1024
                               && x.Entry.Length / Math.Max(1d, x.Entry.CompressedLength) > 1000d))
                return Blocked(analysis, "ZIP 中存在异常压缩比文件，未进行优化");

            var byPath = files.ToDictionary(x => x.LogicalPath, StringComparer.Ordinal);
            var entryFile = SelectEntry(byPath.Keys);
            if (entryFile == null)
                return Blocked(analysis, "ZIP 缺少 HTML 入口文件，无法生成可预览站点");

            // Files that are guaranteed to be removed must not consume the runtime scan budget.
            // Large exported prototypes commonly carry a complete node_modules tree; counting it
            // here would skip the very optimization that is meant to remove it.
            var runtimeTextEntries = files
                .Where(x => !IsNodeModules(x.LogicalPath)
                            && !IsDevelopmentFile(x.LogicalPath)
                            && IsScannedRuntimeText(x.LogicalPath))
                .ToList();
            if (runtimeTextEntries.Any(x => x.Entry.Length > MaxScannedTextFileBytes)
                || runtimeTextEntries.Sum(x => x.Entry.Length) > MaxScannedTextBytes)
            {
                analysis.Warnings.Add("运行文本规模过大，本次跳过自动优化并按原文件保存");
                return new OptimizedBuild { Analysis = analysis };
            }
            var preservePotentialRuntimeFiles = HasUnresolvedDynamicRuntimeLoading(runtimeTextEntries);
            if (preservePotentialRuntimeFiles)
                analysis.Warnings.Add("检测到无法静态确认的运行时加载，本次保留所有潜在依赖");

            var output = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            foreach (var file in files)
            {
                if (IsNodeModules(file.LogicalPath))
                {
                    analysis.NodeModulesFiles++;
                    if (!preservePotentialRuntimeFiles) continue;
                }
                else if (IsDevelopmentFile(file.LogicalPath))
                {
                    analysis.DevelopmentFiles++;
                    if (!preservePotentialRuntimeFiles) continue;
                }
                output[file.LogicalPath] = ReadEntry(file.Entry);
            }

            if (!output.ContainsKey(entryFile))
                return Blocked(analysis, "入口文件被识别为开发产物，未进行自动优化");

            var replacements = new Dictionary<string, string>(StringComparer.Ordinal);
            var pendingStyles = new Queue<(string SourcePath, string OutputPath)>();
            foreach (Match match in ExternalPackageUrlRegex().Matches(Encoding.UTF8.GetString(output[entryFile])))
            {
                var url = match.Value;
                var packageName = match.Groups["package"].Value;
                var packagePath = match.Groups["path"].Value;
                var sourcePath = $"node_modules/{packageName}/{packagePath}";
                if (!byPath.ContainsKey(sourcePath)) continue;
                var outputPath = $"vendor/{packageName}/{packagePath}";
                AddVendorFile(sourcePath, outputPath, byPath, output, pendingStyles);
                replacements[url] = RelativeReference(entryFile, outputPath);
                analysis.LocalizedDependencies++;
                AddPackageLicense(packageName, byPath, output, pendingStyles);
            }

            while (pendingStyles.Count > 0)
            {
                var (sourcePath, outputPath) = pendingStyles.Dequeue();
                var css = Encoding.UTF8.GetString(output[outputPath]);
                foreach (Match match in CssReferenceRegex().Matches(css))
                {
                    var value = match.Groups["path"].Value.Trim().Trim('"', '\'');
                    if (IsIgnoredReference(value) || IsExternalReference(value)) continue;
                    var nestedSource = ResolveReference(sourcePath, value);
                    if (nestedSource == null || !byPath.ContainsKey(nestedSource)) continue;
                    var packageRoot = GetPackageRoot(sourcePath, "node_modules/");
                    if (packageRoot == null || !nestedSource.StartsWith($"{packageRoot}/", StringComparison.Ordinal))
                        continue;
                    var packageRelative = nestedSource[(packageRoot.Length + 1)..];
                    var vendorRoot = GetPackageRoot(outputPath, "vendor/");
                    if (vendorRoot == null) continue;
                    var nestedOutput = $"{vendorRoot}/{packageRelative}";
                    AddVendorFile(nestedSource, nestedOutput, byPath, output, pendingStyles);
                }
            }

            if (replacements.Count > 0)
            {
                var html = Encoding.UTF8.GetString(output[entryFile]);
                foreach (var (from, to) in replacements) html = html.Replace(from, to, StringComparison.Ordinal);
                output[entryFile] = Encoding.UTF8.GetBytes(html);
            }

            RestoreReferencedRuntimeFiles(byPath, output);
            var missing = FindMissingRuntimeReferences(output);
            if (missing.Count > 0)
                return Blocked(analysis, $"入口引用的本地资源缺失：{string.Join("、", missing.Take(3))}");

            foreach (var path in output.Keys.ToList())
                output[path] = RewriteRootReferencesForArtifact(output[path], MimeFor(path), path);

            analysis.OptimizedFiles = output.Count;
            analysis.OptimizedUncompressedBytes = output.Values.Sum(x => (long)x.Length);
            analysis.RemovedFiles = Math.Max(0, analysis.OriginalFiles - output.Count);
            analysis.SavedUncompressedBytes = Math.Max(0, analysis.OriginalUncompressedBytes - analysis.OptimizedUncompressedBytes);

            if (analysis.OriginalEntries > 5000)
                analysis.Reasons.Add($"原包共有 {analysis.OriginalEntries} 项，超过常规网页托管建议值 5000");
            if (analysis.NodeModulesFiles > 0)
                analysis.Reasons.Add($"检测到 {analysis.NodeModulesFiles} 个 node_modules 文件");
            if (analysis.DevelopmentFiles > 0)
                analysis.Reasons.Add($"检测到 {analysis.DevelopmentFiles} 个测试、缓存、锁文件或源码映射");
            if (analysis.LocalizedDependencies > 0)
                analysis.Reasons.Add($"可将 {analysis.LocalizedDependencies} 个外部依赖固定为包内 vendor 文件");

            var stillExternal = ExternalUrlRegex().Matches(Encoding.UTF8.GetString(output[entryFile])).Count;
            if (stillExternal > 0)
                analysis.Warnings.Add($"入口仍包含 {stillExternal} 个外部地址，预览时请确认网络依赖可用");

            var meaningfulSaving = analysis.RemovedFiles >= 100
                                   && analysis.OptimizedFiles <= analysis.OriginalFiles * 0.8;
            analysis.Recommended = meaningfulSaving
                                   || (analysis.OriginalEntries > 5000 && analysis.OptimizedFiles <= 5000);
            return new OptimizedBuild { Analysis = analysis, Files = output, EntryFile = entryFile };
        }
        catch (InvalidDataException)
        {
            return Blocked(analysis, "ZIP 文件无效或已损坏，请重新导出后再试");
        }
        catch (DecoderFallbackException)
        {
            return Blocked(analysis, "入口文件不是有效文本，无法安全分析");
        }
        catch (UriFormatException)
        {
            return Blocked(analysis, "ZIP 中包含无效的资源地址，无法安全分析");
        }
    }

    private static OptimizedBuild Blocked(HostedSiteOptimizationAnalysis analysis, string error)
    {
        analysis.Blocked = true;
        analysis.Error = error;
        return new OptimizedBuild { Analysis = analysis };
    }

    private static void AddVendorFile(
        string sourcePath,
        string outputPath,
        IReadOnlyDictionary<string, ArchiveFile> byPath,
        IDictionary<string, byte[]> output,
        Queue<(string SourcePath, string OutputPath)> pendingStyles)
    {
        if (output.ContainsKey(outputPath) || !byPath.TryGetValue(sourcePath, out var source)) return;
        output[outputPath] = ReadEntry(source.Entry);
        if (outputPath.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
            pendingStyles.Enqueue((sourcePath, outputPath));
    }

    private static void AddPackageLicense(
        string packageName,
        IReadOnlyDictionary<string, ArchiveFile> byPath,
        IDictionary<string, byte[]> output,
        Queue<(string SourcePath, string OutputPath)> pendingStyles)
    {
        foreach (var candidate in new[] { "LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md" })
        {
            var source = $"node_modules/{packageName}/{candidate}";
            if (!byPath.ContainsKey(source)) continue;
            AddVendorFile(source, $"vendor/{packageName}/{candidate}", byPath, output, pendingStyles);
            return;
        }
    }

    private static List<string> FindMissingRuntimeReferences(IReadOnlyDictionary<string, byte[]> output)
    {
        var missing = new List<string>();
        foreach (var (owner, bytes) in output)
        {
            var extension = Path.GetExtension(owner).ToLowerInvariant();
            if (!TryDecodeUtf8(bytes, out var text)) continue;
            var htmlBase = extension is ".html" or ".htm"
                ? HtmlBaseHrefRegex().Match(text).Groups["path"].Value
                : null;
            foreach (var value in RuntimeReferences(extension, text))
            {
                var normalizedValue = value.Trim().Trim('"', '\'');
                if (IsIgnoredReference(normalizedValue) || IsExternalReference(normalizedValue)) continue;
                if (extension is ".js" or ".mjs"
                    && !normalizedValue.StartsWith('.') && !normalizedValue.StartsWith('/'))
                    continue;
                var resolved = extension is ".html" or ".htm"
                    ? ResolveHtmlReference(owner, normalizedValue, htmlBase)
                    : ResolveReference(owner, normalizedValue);
                if (resolved != null && !output.ContainsKey(resolved)) missing.Add(resolved);
            }
        }
        return missing.Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal).ToList();
    }

    private static IEnumerable<string> RuntimeReferences(string extension, string text)
    {
        if (extension is ".html" or ".htm")
        {
            foreach (Match match in HtmlReferenceRegex().Matches(text))
                yield return match.Groups["path"].Value;
            foreach (Match match in HtmlSrcSetRegex().Matches(text))
            foreach (var candidate in match.Groups["paths"].Value.Split(','))
            {
                var value = candidate.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                    .FirstOrDefault();
                if (!string.IsNullOrWhiteSpace(value)) yield return value;
            }
            foreach (Match attribute in HtmlStyleAttributeRegex().Matches(text))
            foreach (Match match in CssReferenceRegex().Matches(attribute.Groups["body"].Value))
                yield return match.Groups["path"].Value;
            foreach (Match block in InlineStyleRegex().Matches(text))
            foreach (Match match in CssReferenceRegex().Matches(block.Groups["body"].Value))
                yield return match.Groups["path"].Value;
            foreach (Match block in InlineScriptRegex().Matches(text))
            foreach (Match match in JavaScriptImportRegex().Matches(block.Groups["body"].Value))
            {
                var value = match.Groups["path"].Value;
                if (value.StartsWith('.') || value.StartsWith('/')) yield return value;
            }
            yield break;
        }
        var regex = extension switch
        {
            ".css" => CssReferenceRegex(),
            ".js" or ".mjs" => JavaScriptImportRegex(),
            _ => null,
        };
        if (regex == null) yield break;
        foreach (Match match in regex.Matches(text))
            yield return match.Groups["path"].Value;
    }

    private static void RestoreReferencedRuntimeFiles(
        IReadOnlyDictionary<string, ArchiveFile> byPath,
        Dictionary<string, byte[]> output)
    {
        while (true)
        {
            var restorable = FindMissingRuntimeReferences(output)
                .Where(byPath.ContainsKey)
                .ToList();
            if (restorable.Count == 0) return;
            foreach (var path in restorable)
                output[path] = ReadEntry(byPath[path].Entry);
        }
    }

    private static bool HasUnresolvedDynamicRuntimeLoading(IEnumerable<ArchiveFile> runtimeTextEntries)
    {
        foreach (var file in runtimeTextEntries)
        {
            var extension = Path.GetExtension(file.LogicalPath).ToLowerInvariant();
            if (extension is not (".html" or ".htm" or ".css" or ".js" or ".mjs")) continue;
            if (!TryDecodeUtf8(ReadEntry(file.Entry), out var text)) return true;
            if (extension == ".css") continue;
            var scripts = extension is ".html" or ".htm"
                ? InlineScriptRegex().Matches(text).Select(x => x.Groups["body"].Value)
                : new[] { text };
            foreach (var script in scripts)
            {
                if (DynamicRuntimeLoaderRegex().Matches(script).Count
                    > StaticDynamicRuntimeReferenceRegex().Matches(script).Count)
                    return true;
            }
        }
        return false;
    }

    private static bool TryDecodeUtf8(byte[] bytes, out string text)
    {
        try
        {
            text = StrictUtf8.GetString(bytes);
            return true;
        }
        catch (DecoderFallbackException)
        {
            text = string.Empty;
            return false;
        }
    }

    private static byte[] ReadEntry(ZipArchiveEntry entry)
    {
        using var source = entry.Open();
        using var output = new MemoryStream(entry.Length > int.MaxValue ? 0 : (int)entry.Length);
        source.CopyTo(output);
        if (output.Length > MaxUncompressedBytes)
            throw new InvalidDataException("entry too large");
        return output.ToArray();
    }

    private static string? DetectRootPrefix(IEnumerable<ZipArchiveEntry> entries)
    {
        string? prefix = null;
        foreach (var entry in entries.Where(x => !string.IsNullOrEmpty(x.Name)))
        {
            var name = NormalizePath(entry.FullName);
            var slash = name.IndexOf('/');
            if (slash < 0) return null;
            var current = name[..(slash + 1)];
            if (prefix == null) prefix = current;
            else if (!string.Equals(prefix, current, StringComparison.Ordinal)) return null;
        }
        return prefix;
    }

    private static string StripRoot(string path, string? prefix)
        => !string.IsNullOrEmpty(prefix) && path.StartsWith(prefix, StringComparison.Ordinal)
            ? path[prefix.Length..]
            : path;

    private static string? SelectEntry(IEnumerable<string> paths)
    {
        var list = paths.ToList();
        return list.FirstOrDefault(x => x.Equals("index.html", StringComparison.OrdinalIgnoreCase))
               ?? list.FirstOrDefault(x => x.Equals("index.htm", StringComparison.OrdinalIgnoreCase))
               ?? list.FirstOrDefault(
                   x => HostedSiteService.GetMimeType(Path.GetExtension(x)) == "text/html");
    }

    private static bool IsNodeModules(string path)
        => path.Split('/').Any(x => x.Equals("node_modules", StringComparison.OrdinalIgnoreCase));

    private static bool IsDevelopmentFile(string path)
    {
        var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Any(DevelopmentDirectoryNames.Contains)
               || DevelopmentFileNames.Contains(parts.LastOrDefault() ?? string.Empty)
               || path.EndsWith(".map", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsScannedRuntimeText(string path)
        => Path.GetExtension(path).ToLowerInvariant() is ".html" or ".htm" or ".css" or ".js" or ".mjs";

    private static bool IsUnsafePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Contains('\0') || path.StartsWith('/')) return true;
        if (path.Length >= 3 && char.IsLetter(path[0]) && path[1] == ':' && path[2] == '/') return true;
        return path.Split('/').Any(x => x == "..");
    }

    private static string NormalizePath(string path) => path.Replace('\\', '/');

    private static string? GetPackageRoot(string path, string marker)
    {
        if (!path.StartsWith(marker, StringComparison.Ordinal)) return null;
        var remainder = path[marker.Length..];
        var segments = remainder.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0) return null;
        var packageSegments = segments[0].StartsWith('@') ? 2 : 1;
        if (segments.Length < packageSegments) return null;
        return marker + string.Join('/', segments.Take(packageSegments));
    }

    private static string? ResolveReference(string owner, string value)
    {
        var path = value.Split('?', '#')[0].Trim();
        if (string.IsNullOrWhiteSpace(path)) return null;
        path = Uri.UnescapeDataString(path).Replace('\\', '/');
        var parts = new List<string>();
        if (!path.StartsWith('/'))
            parts.AddRange(owner.Split('/').SkipLast(1));
        foreach (var part in path.TrimStart('/').Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (part == ".") continue;
            if (part == "..")
            {
                if (parts.Count == 0) return null;
                parts.RemoveAt(parts.Count - 1);
            }
            else parts.Add(part);
        }
        return string.Join('/', parts);
    }

    private static string? ResolveHtmlReference(string owner, string value, string? baseHref)
    {
        if (string.IsNullOrWhiteSpace(baseHref)) return ResolveReference(owner, value);
        if (IsExternalReference(baseHref)) return null;

        var basePath = baseHref.Split('?', '#')[0].Trim().Replace('\\', '/');
        if (string.IsNullOrWhiteSpace(basePath)) return ResolveReference(owner, value);
        var baseOwner = basePath.EndsWith("/", StringComparison.Ordinal)
            ? ResolveReference(owner, basePath + "__base__.html")
            : ResolveReference(owner, basePath);
        return string.IsNullOrWhiteSpace(baseOwner)
            ? ResolveReference(owner, value)
            : ResolveReference(baseOwner, value);
    }

    private static string RelativeReference(string owner, string target)
    {
        var ownerSegments = owner.Split('/').SkipLast(1).ToArray();
        var targetSegments = target.Split('/');
        var common = 0;
        while (common < ownerSegments.Length && common < targetSegments.Length
               && ownerSegments[common] == targetSegments[common]) common++;
        var segments = Enumerable.Repeat("..", ownerSegments.Length - common)
            .Concat(targetSegments.Skip(common));
        var relative = string.Join('/', segments);
        return relative.StartsWith('.') ? relative : $"./{relative}";
    }

    private static bool IsExternalReference(string value)
        => value.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
           || value.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
           || value.StartsWith("//", StringComparison.Ordinal);

    private static bool IsIgnoredReference(string value)
        => string.IsNullOrWhiteSpace(value)
           || value.StartsWith('#')
           || value.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
           || value.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase)
           || value.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)
           || value.StartsWith("tel:", StringComparison.OrdinalIgnoreCase);

    private static string MimeFor(string path)
        => HostedSiteService.GetMimeType(Path.GetExtension(path));

    [GeneratedRegex("https?://(?:unpkg\\.com/|cdn\\.jsdelivr\\.net/npm/)(?<package>@?[^@/\\s\\\"']+(?:/[^@/\\s\\\"']+)?)(?:@[^/\\s\\\"']+)?/(?<path>[^?#\\s\\\"']+)", RegexOptions.IgnoreCase)]
    private static partial Regex ExternalPackageUrlRegex();

    [GeneratedRegex("https?://[^\\s\\\"'<>]+", RegexOptions.IgnoreCase)]
    private static partial Regex ExternalUrlRegex();

    [GeneratedRegex("<base\\b[^>]*?href\\s*=\\s*[\\\"'](?<path>[^\\\"']+)[\\\"']", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex HtmlBaseHrefRegex();

    [GeneratedRegex("<(?:script|link|img|source|video|audio|iframe|object)\\b[^>]*?(?:src|href|poster|data)\\s*=\\s*[\\\"'](?<path>[^\\\"']+)[\\\"']", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex HtmlReferenceRegex();

    [GeneratedRegex("<(?:img|source)\\b[^>]*?srcset\\s*=\\s*[\\\"'](?<paths>[^\\\"']+)[\\\"']", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex HtmlSrcSetRegex();

    [GeneratedRegex("\\bstyle\\s*=\\s*(?<quote>[\\\"'])(?<body>.*?)\\k<quote>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex HtmlStyleAttributeRegex();

    [GeneratedRegex("(?:url\\(\\s*|@import\\s+)[\\\"']?(?<path>[^\\)\\\"']+)", RegexOptions.IgnoreCase)]
    private static partial Regex CssReferenceRegex();

    [GeneratedRegex("(?:from\\s+|import\\s*(?:\\(\\s*)?|require\\s*\\(\\s*|fetch\\s*\\(\\s*|new\\s+(?:Shared)?Worker\\s*\\(\\s*|navigator\\.serviceWorker\\.register\\s*\\(\\s*|importScripts\\s*\\(\\s*)[\\\"'](?<path>[^\\\"']+)[\\\"']", RegexOptions.IgnoreCase)]
    private static partial Regex JavaScriptImportRegex();

    [GeneratedRegex("<script\\b[^>]*>(?<body>[\\s\\S]*?)</script\\s*>", RegexOptions.IgnoreCase)]
    private static partial Regex InlineScriptRegex();

    [GeneratedRegex("<style\\b[^>]*>(?<body>[\\s\\S]*?)</style\\s*>", RegexOptions.IgnoreCase)]
    private static partial Regex InlineStyleRegex();

    [GeneratedRegex("(?:import\\s*\\(|require\\s*\\(|fetch\\s*\\(|new\\s+(?:Shared)?Worker\\s*\\(|navigator\\.serviceWorker\\.register\\s*\\(|importScripts\\s*\\()", RegexOptions.IgnoreCase)]
    private static partial Regex DynamicRuntimeLoaderRegex();

    [GeneratedRegex("(?:import\\s*\\(\\s*|require\\s*\\(\\s*|fetch\\s*\\(\\s*|new\\s+(?:Shared)?Worker\\s*\\(\\s*|navigator\\.serviceWorker\\.register\\s*\\(\\s*|importScripts\\s*\\(\\s*)[\\\"'][^\\\"']+[\\\"']", RegexOptions.IgnoreCase)]
    private static partial Regex StaticDynamicRuntimeReferenceRegex();
}
