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
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<DocumentSyncWorker> _logger;
    private readonly IHttpClientFactory _httpClientFactory;

    /// <summary>每 2 分钟扫描一次待同步条目</summary>
    private static readonly TimeSpan ScanInterval = TimeSpan.FromMinutes(2);

    public DocumentSyncWorker(
        IServiceScopeFactory scopeFactory,
        ILogger<DocumentSyncWorker> logger,
        IHttpClientFactory httpClientFactory)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
        _httpClientFactory = httpClientFactory;
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
            catch (Exception ex) when (ex is not OperationCanceledException)
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

        // 查找需要同步的条目：
        // 1. 有 SourceUrl 或 SourceType == github_directory
        // 2. 有 SyncIntervalMinutes > 0
        // 3. 未被暂停
        // 4. SyncStatus == Syncing (手动触发) 或 距上次同步已超过间隔
        var filter = Builders<DocumentEntry>.Filter.And(
            Builders<DocumentEntry>.Filter.Or(
                Builders<DocumentEntry>.Filter.Ne(e => e.SourceUrl, null),
                Builders<DocumentEntry>.Filter.Eq(e => e.SourceType, DocumentSourceType.GithubDirectory)
            ),
            Builders<DocumentEntry>.Filter.Gt(e => e.SyncIntervalMinutes, 0),
            Builders<DocumentEntry>.Filter.Ne(e => e.IsPaused, true),
            Builders<DocumentEntry>.Filter.Or(
                // 手动触发
                Builders<DocumentEntry>.Filter.Eq(e => e.SyncStatus, DocumentSyncStatus.Syncing),
                // 从未同步过
                Builders<DocumentEntry>.Filter.Eq(e => e.LastSyncAt, null),
                // 已过同步间隔（用 Builders 无法做动态计算，取所有有 SourceUrl 的条目在代码里过滤）
                Builders<DocumentEntry>.Filter.Lt(e => e.LastSyncAt, now.AddHours(-24))
            )
        );

        var candidates = await db.DocumentEntries.Find(filter)
            .Limit(20) // 每轮最多处理 20 个
            .ToListAsync(ct);

        // 在代码里精确过滤到期的条目
        var dueEntries = candidates.Where(e =>
            e.SyncStatus == DocumentSyncStatus.Syncing || // 手动触发
            e.LastSyncAt == null || // 从未同步
            (e.SyncIntervalMinutes > 0 && e.LastSyncAt.Value.AddMinutes(e.SyncIntervalMinutes.Value) <= now)
        ).ToList();

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
            // 标记为同步中
            await db.DocumentEntries.UpdateOneAsync(
                e => e.Id == entry.Id,
                Builders<DocumentEntry>.Update
                    .Set(e => e.SyncStatus, DocumentSyncStatus.Syncing),
                cancellationToken: CancellationToken.None);

            var githubSyncService = new GitHubDirectorySyncService(
                _scopeFactory.CreateScope().ServiceProvider
                    .GetRequiredService<ILogger<GitHubDirectorySyncService>>());

            var diff = await githubSyncService.SyncDirectoryAsync(db, documentService, entry, ct);

            // 标记同步完成
            var update = Builders<DocumentEntry>.Update
                .Set(e => e.SyncStatus, DocumentSyncStatus.Idle)
                .Set(e => e.SyncError, null)
                .Set(e => e.LastSyncAt, DateTime.UtcNow)
                .Set(e => e.UpdatedAt, DateTime.UtcNow);

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
        catch (Exception ex) when (ex is not OperationCanceledException)
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
            // 标记为同步中
            await db.DocumentEntries.UpdateOneAsync(
                e => e.Id == entry.Id,
                Builders<DocumentEntry>.Update
                    .Set(e => e.SyncStatus, DocumentSyncStatus.Syncing),
                cancellationToken: CancellationToken.None);

            // 拉取内容（带条件请求头，避免重复拉取被封控）
            var client = _httpClientFactory.CreateClient("DocumentSync");
            client.Timeout = TimeSpan.FromSeconds(30);

            using var request = new HttpRequestMessage(HttpMethod.Get, entry.SourceUrl);
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

            // 304 Not Modified → 服务端确认未变化，仅更新 LastSyncAt
            if (response.StatusCode == HttpStatusCode.NotModified)
            {
                await db.DocumentEntries.UpdateOneAsync(
                    e => e.Id == entry.Id,
                    Builders<DocumentEntry>.Update
                        .Set(e => e.SyncStatus, DocumentSyncStatus.Idle)
                        .Set(e => e.SyncError, null)
                        .Set(e => e.LastSyncAt, DateTime.UtcNow)
                        .Set(e => e.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
                _logger.LogDebug("[DocumentSyncWorker] {EntryId} returned 304, skipped", entry.Id);
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

            if (!string.IsNullOrEmpty(entry.ContentHash) && entry.ContentHash == newHash)
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
                        .Set(e => e.LastModifiedHeader, newLastModified),
                    cancellationToken: CancellationToken.None);
                _logger.LogDebug("[DocumentSyncWorker] {EntryId} content hash unchanged, skipped", entry.Id);
                return;
            }

            // 真的有变化 → 解析、保存、落日志
            var parsed = await documentService.ParseAsync(content);
            parsed.Title = entry.Title;
            await documentService.SaveAsync(parsed);

            var summary = content.Length > 200 ? content[..200] : content;

            var previousHash = entry.ContentHash;
            var previousLength = entry.FileSize;

            await db.DocumentEntries.UpdateOneAsync(
                e => e.Id == entry.Id,
                Builders<DocumentEntry>.Update
                    .Set(e => e.DocumentId, parsed.Id)
                    .Set(e => e.ContentType, responseContentType)
                    .Set(e => e.FileSize, newLength)
                    .Set(e => e.Summary, summary.Trim())
                    .Set(e => e.SyncStatus, DocumentSyncStatus.Idle)
                    .Set(e => e.SyncError, null)
                    .Set(e => e.LastSyncAt, DateTime.UtcNow)
                    .Set(e => e.LastChangedAt, DateTime.UtcNow)
                    .Set(e => e.UpdatedAt, DateTime.UtcNow)
                    .Set(e => e.ContentHash, newHash)
                    .Set(e => e.LastETag, newETag)
                    .Set(e => e.LastModifiedHeader, newLastModified),
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
        catch (Exception ex) when (ex is not OperationCanceledException)
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
                .Set(e => e.UpdatedAt, DateTime.UtcNow),
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
}
