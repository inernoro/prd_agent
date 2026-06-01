using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 文档订阅同步服务 — 定期拉取外部 URL 内容更新文档。
/// 设计原则：
/// 1) 避免重复拉取被封控：URL 订阅使用 If-None-Match / If-Modified-Since 条件请求，
///    服务端返回 304 时直接判定无变化；并以 ContentHash 兜底判定。
/// 2) 日志只记录"有意义的事件"：内容真的变了 → DocumentSyncLog kind=change；
///    出错 → kind=error；无变化 → 只更新 LastSyncAt，不落日志，避免日志膨胀。
/// 3) 暂停的订阅（IsPaused）跳过扫描。
/// </summary>
public class DocumentSyncWorker : BackgroundService
{
    private static readonly TimeSpan SyncLeaseDuration = TimeSpan.FromMinutes(10);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<DocumentSyncWorker> _logger;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ISafeOutboundUrlValidator _urlValidator;
    private readonly string _instanceId = $"{Environment.MachineName}:{Environment.ProcessId}:{Guid.NewGuid():N}";

    /// <summary>每 2 分钟扫描一次待同步条目</summary>
    private static readonly TimeSpan ScanInterval = TimeSpan.FromMinutes(2);

    public DocumentSyncWorker(
        IServiceScopeFactory scopeFactory,
        ILogger<DocumentSyncWorker> logger,
        IHttpClientFactory httpClientFactory,
        ISafeOutboundUrlValidator urlValidator)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
        _httpClientFactory = httpClientFactory;
        _urlValidator = urlValidator;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[DocumentSyncWorker] Started, scan interval: {Interval}", ScanInterval);

        using var timer = new PeriodicTimer(ScanInterval);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await SyncDueEntriesAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[DocumentSyncWorker] Scan cycle failed");
            }
        }
    }

    private async Task SyncDueEntriesAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var documentService = scope.ServiceProvider.GetRequiredService<IDocumentService>();

        var now = DateTime.UtcNow;

        var regularCandidates = await db.DocumentEntries.Find(Builders<DocumentEntry>.Filter.And(
                Builders<DocumentEntry>.Filter.Ne(e => e.SourceType, DocumentSourceType.GithubDirectory),
                Builders<DocumentEntry>.Filter.Ne(e => e.SourceUrl, null),
                Builders<DocumentEntry>.Filter.Gt(e => e.SyncIntervalMinutes, 0),
                Builders<DocumentEntry>.Filter.Ne(e => e.IsPaused, true),
                Builders<DocumentEntry>.Filter.Or(
                    Builders<DocumentEntry>.Filter.Eq(e => e.SyncStatus, DocumentSyncStatus.Syncing),
                    Builders<DocumentEntry>.Filter.Eq(e => e.LastSyncAt, null),
                    Builders<DocumentEntry>.Filter.Lt(e => e.LastSyncAt, now.AddHours(-24))
                )))
            .Limit(50)
            .ToListAsync(ct);

        var githubCandidates = await db.DocumentEntries.Find(Builders<DocumentEntry>.Filter.And(
                Builders<DocumentEntry>.Filter.Eq(e => e.SourceType, DocumentSourceType.GithubDirectory),
                Builders<DocumentEntry>.Filter.Gt(e => e.SyncIntervalMinutes, 0),
                Builders<DocumentEntry>.Filter.Ne(e => e.IsPaused, true)))
            .ToListAsync(ct);

        var dueEntries = regularCandidates
            .Concat(githubCandidates)
            .Where(e => DocumentSyncSchedule.IsDue(e, now))
            .DistinctBy(e => e.Id)
            .Take(20)
            .ToList();

        if (dueEntries.Count == 0) return;

        _logger.LogInformation("[DocumentSyncWorker] Found {Count} entries to sync", dueEntries.Count);

        foreach (var entry in dueEntries)
        {
            if (entry.SourceType == DocumentSourceType.GithubDirectory)
                await SyncGitHubDirectoryAsync(db, documentService, entry, ct);
            else
                await SyncSingleEntryAsync(db, documentService, entry, ct);
        }
    }

    private async Task SyncGitHubDirectoryAsync(
        MongoDbContext db,
        IDocumentService documentService,
        DocumentEntry entry,
        CancellationToken ct)
    {
        var startedAt = DateTime.UtcNow;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            if (!await TryAcquireSyncLeaseAsync(db, entry, ct))
                return;

            var githubSyncService = new GitHubDirectorySyncService(
                _scopeFactory.CreateScope().ServiceProvider
                    .GetRequiredService<ILogger<GitHubDirectorySyncService>>());

            var diff = await githubSyncService.SyncDirectoryAsync(db, documentService, entry, ct);

            // 标记同步完成
            var update = Builders<DocumentEntry>.Update
                .Set(e => e.SyncStatus, DocumentSyncStatus.Idle)
                .Set(e => e.SyncError, null)
                .Set(e => e.LastSyncAt, DateTime.UtcNow)
                .Set(e => e.UpdatedAt, DateTime.UtcNow)
                .Unset(e => e.SyncLeaseOwner)
                .Unset(e => e.SyncLeaseExpiresAt);

            // 只在真的有文件变化时才更新 LastChangedAt
            if (diff.HasChanges)
                update = update.Set(e => e.LastChangedAt, DateTime.UtcNow);

            await db.DocumentEntries.UpdateOneAsync(
                e => e.Id == entry.Id,
                update,
                cancellationToken: CancellationToken.None);

            sw.Stop();

            // 只在有变化时落日志
            if (diff.HasChanges)
            {
                await db.DocumentSyncLogs.InsertOneAsync(new DocumentSyncLog
                {
                    EntryId = entry.Id,
                    StoreId = entry.StoreId,
                    SyncedAt = startedAt,
                    Kind = DocumentSyncLogKind.Change,
                    ChangeSummary = diff.BuildSummary(),
                    FileChanges = diff.FileChanges,
                    DurationMs = (int)sw.ElapsedMilliseconds,
                }, cancellationToken: CancellationToken.None);
            }

            _logger.LogInformation(
                "[DocumentSyncWorker] GitHub directory sync completed for {EntryId} (changes={Changes})",
                entry.Id, diff.HasChanges);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            sw.Stop();
            _logger.LogWarning(ex, "[DocumentSyncWorker] GitHub directory sync failed for {EntryId}", entry.Id);
            await MarkSyncError(db, entry, ex.Message, startedAt, (int)sw.ElapsedMilliseconds);
        }
    }

    private async Task SyncSingleEntryAsync(
        MongoDbContext db,
        IDocumentService documentService,
        DocumentEntry entry,
        CancellationToken ct)
    {
        var startedAt = DateTime.UtcNow;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            if (!await TryAcquireSyncLeaseAsync(db, entry, ct))
                return;

            // 拉取内容（带条件请求头，避免重复拉取被封控）
            var client = _httpClientFactory.CreateClient("DocumentSync");
            client.Timeout = TimeSpan.FromSeconds(30);

            var sourceUri = await _urlValidator.EnsureSafeHttpUrlAsync(entry.SourceUrl, "文档订阅源", ct);
            using var request = new HttpRequestMessage(HttpMethod.Get, sourceUri);
            request.Headers.UserAgent.ParseAdd("PrdAgent-DocumentSync/1.0");
            if (!string.IsNullOrEmpty(entry.LastETag))
            {
                if (EntityTagHeaderValue.TryParse(entry.LastETag, out var etag))
                    request.Headers.IfNoneMatch.Add(etag);
            }
            if (!string.IsNullOrEmpty(entry.LastModifiedHeader)
                && DateTimeOffset.TryParse(entry.LastModifiedHeader, out var lastModified))
            {
                request.Headers.IfModifiedSince = lastModified;
            }

            using var response = await client.SendAsync(request, ct);

            // 304 Not Modified → 服务端确认未变化，仅更新 LastSyncAt（但要先确认 Document 仍存在）
            if (response.StatusCode == HttpStatusCode.NotModified)
            {
                // 自愈：与 hash 短路同款保护——若 Document 已被它处删除，必须重拉
                var docOk = !string.IsNullOrEmpty(entry.DocumentId)
                    && await documentService.GetByIdAsync(entry.DocumentId) is { } d304
                    && !string.IsNullOrWhiteSpace(d304.RawContent);
                if (docOk)
                {
                    await db.DocumentEntries.UpdateOneAsync(
                        e => e.Id == entry.Id,
                        Builders<DocumentEntry>.Update
                            .Set(e => e.SyncStatus, DocumentSyncStatus.Idle)
                            .Set(e => e.SyncError, null)
                            .Set(e => e.LastSyncAt, DateTime.UtcNow)
                            .Set(e => e.UpdatedAt, DateTime.UtcNow)
                            .Unset(e => e.SyncLeaseOwner)
                            .Unset(e => e.SyncLeaseExpiresAt),
                        cancellationToken: CancellationToken.None);
                    _logger.LogDebug("[DocumentSyncWorker] {EntryId} returned 304, skipped", entry.Id);
                    return;
                }
                _logger.LogWarning(
                    "[DocumentSyncWorker] {EntryId} got 304 but Document {DocId} missing/empty; forcing live fetch (drop ETag)",
                    entry.Id, entry.DocumentId);
                // 304 但 Document 丢了 → 重发请求不带 If-None-Match，强制拉全量
                using var freshReq = new HttpRequestMessage(HttpMethod.Get, sourceUri);
                freshReq.Headers.UserAgent.ParseAdd("PrdAgent-DocumentSync/1.0");
                using var freshResp = await client.SendAsync(freshReq, ct);
                freshResp.EnsureSuccessStatusCode();
                response.Dispose();
                // 重新装载 response 变量本身不可（using 限制），改写为下面用 freshResp 复制状态
                var freshContent = await freshResp.Content.ReadAsStringAsync(ct);
                if (string.IsNullOrWhiteSpace(freshContent))
                {
                    sw.Stop();
                    await MarkSyncError(db, entry, "重拉到的内容为空", startedAt, (int)sw.ElapsedMilliseconds);
                    return;
                }
                var freshHash = ComputeHash(freshContent);
                var freshParsed = await documentService.ParseAsync(freshContent);
                freshParsed.Title = entry.Title;
                await documentService.SaveAsync(freshParsed);
                // 自愈：源内容并没真变，只是重建被误删的 Document。
                // 不更新 LastChangedAt，避免错误触发 DocBrowser 的 NEW 徽标。
                await db.DocumentEntries.UpdateOneAsync(
                    e => e.Id == entry.Id,
                    Builders<DocumentEntry>.Update
                        .Set(e => e.DocumentId, freshParsed.Id)
                        .Set(e => e.ContentHash, freshHash)
                        .Set(e => e.FileSize, (long)Encoding.UTF8.GetByteCount(freshContent))
                        .Set(e => e.SyncStatus, DocumentSyncStatus.Idle)
                        .Set(e => e.SyncError, null)
                        .Set(e => e.LastSyncAt, DateTime.UtcNow)
                        .Set(e => e.UpdatedAt, DateTime.UtcNow)
                        .Unset(e => e.SyncLeaseOwner)
                        .Unset(e => e.SyncLeaseExpiresAt),
                    cancellationToken: CancellationToken.None);
                _logger.LogInformation("[DocumentSyncWorker] {EntryId} self-healed empty Document via live fetch", entry.Id);
                return;
            }

            response.EnsureSuccessStatusCode();

            var content = await response.Content.ReadAsStringAsync(ct);
            if (string.IsNullOrWhiteSpace(content))
            {
                sw.Stop();
                await MarkSyncError(db, entry, "拉取到的内容为空", startedAt, (int)sw.ElapsedMilliseconds);
                return;
            }

            // hash 兜底：即使服务端不支持 304，相同内容也不会重复落库/落日志
            var newHash = ComputeHash(content);
            var newLength = (long)Encoding.UTF8.GetByteCount(content);
            var newETag = response.Headers.ETag?.Tag;
            var newLastModified = response.Content.Headers.LastModified?.ToString("R");
            var responseContentType = response.Content.Headers.ContentType?.MediaType ?? "text/html";
            // 自愈标志：内容 hash 没变但 Document 丢了，需要重建 → 不算"真实变化"，不动 LastChangedAt
            var isSelfHeal = false;

            if (!string.IsNullOrEmpty(entry.ContentHash) && entry.ContentHash == newHash)
            {
                // 自愈：内容未变但 DocumentId 引用的 Document 可能已被其它 entry 删除路径误删
                // （历史 bug：DeleteEntry 无条件级联删共享 Document，此处又短路不重写 → 永久空白）
                var docStillExists = !string.IsNullOrEmpty(entry.DocumentId)
                    && await documentService.GetByIdAsync(entry.DocumentId) is { } d
                    && !string.IsNullOrWhiteSpace(d.RawContent);
                if (docStillExists)
                {
                    // 内容未变 → 仅更新 LastSyncAt + 缓存头（如有更新），不落日志
                    await db.DocumentEntries.UpdateOneAsync(
                        e => e.Id == entry.Id,
                        Builders<DocumentEntry>.Update
                            .Set(e => e.SyncStatus, DocumentSyncStatus.Idle)
                            .Set(e => e.SyncError, null)
                            .Set(e => e.LastSyncAt, DateTime.UtcNow)
                            .Set(e => e.UpdatedAt, DateTime.UtcNow)
                            .Set(e => e.LastETag, newETag)
                            .Set(e => e.LastModifiedHeader, newLastModified)
                            .Unset(e => e.SyncLeaseOwner)
                            .Unset(e => e.SyncLeaseExpiresAt),
                        cancellationToken: CancellationToken.None);
                    _logger.LogDebug("[DocumentSyncWorker] {EntryId} content hash unchanged, skipped", entry.Id);
                    return;
                }
                _logger.LogWarning(
                    "[DocumentSyncWorker] {EntryId} hash unchanged but Document {DocId} missing/empty; forcing re-save",
                    entry.Id, entry.DocumentId);
                isSelfHeal = true;
                // fall through 到下面的"重新解析、保存、落日志"分支，把 Document 重建回来
            }

            // 真的有变化 → 解析、保存、落日志
            var parsed = await documentService.ParseAsync(content);
            parsed.Title = entry.Title;
            await documentService.SaveAsync(parsed);

            var summary = content.Length > 200 ? content[..200] : content;

            var previousHash = entry.ContentHash;
            var previousLength = entry.FileSize;

            var entryUpdate = Builders<DocumentEntry>.Update
                .Set(e => e.DocumentId, parsed.Id)
                .Set(e => e.ContentType, responseContentType)
                .Set(e => e.FileSize, newLength)
                .Set(e => e.Summary, summary.Trim())
                .Set(e => e.SyncStatus, DocumentSyncStatus.Idle)
                .Set(e => e.SyncError, null)
                .Set(e => e.LastSyncAt, DateTime.UtcNow)
                .Set(e => e.UpdatedAt, DateTime.UtcNow)
                .Set(e => e.ContentHash, newHash)
                .Set(e => e.LastETag, newETag)
                .Set(e => e.LastModifiedHeader, newLastModified)
                .Unset(e => e.SyncLeaseOwner)
                .Unset(e => e.SyncLeaseExpiresAt);
            // 自愈分支：源内容并没真变，只是重建被误删 Document → 不动 LastChangedAt 避免误亮 NEW
            if (!isSelfHeal) entryUpdate = entryUpdate.Set(e => e.LastChangedAt, DateTime.UtcNow);
            await db.DocumentEntries.UpdateOneAsync(
                e => e.Id == entry.Id,
                entryUpdate,
                cancellationToken: CancellationToken.None);

            sw.Stop();

            await db.DocumentSyncLogs.InsertOneAsync(new DocumentSyncLog
            {
                EntryId = entry.Id,
                StoreId = entry.StoreId,
                SyncedAt = startedAt,
                Kind = DocumentSyncLogKind.Change,
                PreviousHash = previousHash,
                CurrentHash = newHash,
                PreviousLength = previousHash == null ? null : previousLength,
                CurrentLength = newLength,
                ChangeSummary = BuildUrlChangeSummary(previousLength, newLength, previousHash == null),
                DurationMs = (int)sw.ElapsedMilliseconds,
            }, cancellationToken: CancellationToken.None);

            _logger.LogInformation("[DocumentSyncWorker] Synced entry {EntryId} from {Url}, {Size} chars",
                entry.Id, entry.SourceUrl, content.Length);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            sw.Stop();
            _logger.LogWarning(ex, "[DocumentSyncWorker] Failed to sync entry {EntryId} from {Url}",
                entry.Id, entry.SourceUrl);
            await MarkSyncError(db, entry, ex.Message, startedAt, (int)sw.ElapsedMilliseconds);
        }
    }

    private static string ComputeHash(string content)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash);
    }

    private static string BuildUrlChangeSummary(long previousLength, long newLength, bool isFirstSync)
    {
        if (isFirstSync)
            return $"首次同步，{newLength} 字节";

        var delta = newLength - previousLength;
        if (delta == 0)
            return "正文内容更新";
        var sign = delta > 0 ? "+" : "";
        return $"正文 {sign}{delta} 字节";
    }

    private static async Task MarkSyncError(
        MongoDbContext db,
        DocumentEntry entry,
        string error,
        DateTime startedAt,
        int durationMs)
    {
        var truncated = error.Length > 500 ? error[..500] : error;

        await db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entry.Id,
            Builders<DocumentEntry>.Update
                .Set(e => e.SyncStatus, DocumentSyncStatus.Error)
                .Set(e => e.SyncError, truncated)
                .Set(e => e.LastSyncAt, DateTime.UtcNow)
                .Set(e => e.UpdatedAt, DateTime.UtcNow)
                .Unset(e => e.SyncLeaseOwner)
                .Unset(e => e.SyncLeaseExpiresAt),
            cancellationToken: CancellationToken.None);

        await db.DocumentSyncLogs.InsertOneAsync(new DocumentSyncLog
        {
            EntryId = entry.Id,
            StoreId = entry.StoreId,
            SyncedAt = startedAt,
            Kind = DocumentSyncLogKind.Error,
            ErrorMessage = truncated,
            DurationMs = durationMs,
        }, cancellationToken: CancellationToken.None);
    }

    private async Task<bool> TryAcquireSyncLeaseAsync(
        MongoDbContext db,
        DocumentEntry entry,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var leaseExpiresAt = now.Add(SyncLeaseDuration);

        var filter = Builders<DocumentEntry>.Filter.And(
            Builders<DocumentEntry>.Filter.Eq(e => e.Id, entry.Id),
            Builders<DocumentEntry>.Filter.Ne(e => e.IsPaused, true),
            Builders<DocumentEntry>.Filter.Or(
                Builders<DocumentEntry>.Filter.Eq(e => e.SyncLeaseOwner, null),
                Builders<DocumentEntry>.Filter.Lt(e => e.SyncLeaseExpiresAt, now),
                Builders<DocumentEntry>.Filter.Eq(e => e.SyncLeaseOwner, _instanceId)
            ));

        var update = Builders<DocumentEntry>.Update
            .Set(e => e.SyncStatus, DocumentSyncStatus.Syncing)
            .Set(e => e.SyncLeaseOwner, _instanceId)
            .Set(e => e.SyncLeaseExpiresAt, leaseExpiresAt);

        var result = await db.DocumentEntries.UpdateOneAsync(filter, update, cancellationToken: ct);
        if (result.ModifiedCount == 0)
        {
            _logger.LogDebug("[DocumentSyncWorker] Lease busy for {EntryId}, skipped on {InstanceId}", entry.Id, _instanceId);
            return false;
        }

        return true;
    }
}
