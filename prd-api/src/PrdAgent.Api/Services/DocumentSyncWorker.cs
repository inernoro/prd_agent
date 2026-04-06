using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 文档订阅同步服务 — 定期拉取外部 URL 内容更新文档。
/// 使用 .NET 8 原生 PeriodicTimer，不依赖外部调度器。
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
        // 1. 有 SourceUrl
        // 2. 有 SyncIntervalMinutes > 0
        // 3. SyncStatus == Syncing (手动触发) 或 距上次同步已超过间隔
        var filter = Builders<DocumentEntry>.Filter.And(
            Builders<DocumentEntry>.Filter.Ne(e => e.SourceUrl, null),
            Builders<DocumentEntry>.Filter.Gt(e => e.SyncIntervalMinutes, 0),
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
            await SyncSingleEntryAsync(db, documentService, entry, ct);
        }
    }

    private async Task SyncSingleEntryAsync(
        MongoDbContext db,
        IDocumentService documentService,
        DocumentEntry entry,
        CancellationToken ct)
    {
        try
        {
            // 标记为同步中
            await db.DocumentEntries.UpdateOneAsync(
                e => e.Id == entry.Id,
                Builders<DocumentEntry>.Update
                    .Set(e => e.SyncStatus, DocumentSyncStatus.Syncing),
                cancellationToken: CancellationToken.None);

            // 拉取内容
            var client = _httpClientFactory.CreateClient("DocumentSync");
            client.Timeout = TimeSpan.FromSeconds(30);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("PrdAgent-DocumentSync/1.0");

            var response = await client.GetAsync(entry.SourceUrl, ct);
            response.EnsureSuccessStatusCode();

            var content = await response.Content.ReadAsStringAsync(ct);

            if (string.IsNullOrWhiteSpace(content))
            {
                await MarkSyncError(db, entry.Id, "拉取到的内容为空");
                return;
            }

            // 检测内容类型
            var responseContentType = response.Content.Headers.ContentType?.MediaType ?? "text/html";

            // 解析并保存到 ParsedPrd
            var parsed = await documentService.ParseAsync(content);
            parsed.Title = entry.Title;
            await documentService.SaveAsync(parsed);

            // 更新摘要
            var summary = content.Length > 200 ? content[..200] : content;

            // 更新 DocumentEntry
            await db.DocumentEntries.UpdateOneAsync(
                e => e.Id == entry.Id,
                Builders<DocumentEntry>.Update
                    .Set(e => e.DocumentId, parsed.Id)
                    .Set(e => e.ContentType, responseContentType)
                    .Set(e => e.FileSize, Encoding.UTF8.GetByteCount(content))
                    .Set(e => e.Summary, summary.Trim())
                    .Set(e => e.SyncStatus, DocumentSyncStatus.Idle)
                    .Set(e => e.SyncError, null)
                    .Set(e => e.LastSyncAt, DateTime.UtcNow)
                    .Set(e => e.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);

            _logger.LogInformation("[DocumentSyncWorker] Synced entry {EntryId} from {Url}, {Size} chars",
                entry.Id, entry.SourceUrl, content.Length);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "[DocumentSyncWorker] Failed to sync entry {EntryId} from {Url}",
                entry.Id, entry.SourceUrl);
            await MarkSyncError(db, entry.Id, ex.Message);
        }
    }

    private static async Task MarkSyncError(MongoDbContext db, string entryId, string error)
    {
        await db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entryId,
            Builders<DocumentEntry>.Update
                .Set(e => e.SyncStatus, DocumentSyncStatus.Error)
                .Set(e => e.SyncError, error.Length > 500 ? error[..500] : error)
                .Set(e => e.LastSyncAt, DateTime.UtcNow)
                .Set(e => e.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
    }
}
