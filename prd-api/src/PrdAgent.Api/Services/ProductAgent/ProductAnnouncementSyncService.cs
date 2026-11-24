using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed record ProductAnnouncementSyncStatus(string Status, string RunId, string Message, int Pages,
    int Discovered, int Updated, int Conflicts, DateTime? LastSuccessAt, DateTime? NextRunAt, string? CalendarError,
    long Total, long DetailSucceeded, long Failed, long Matched, long Pending, int NextPage, bool ListingComplete);
public sealed record ProductAnnouncementRecord(string Id, string Url, string Title, string ApplicationName, string Version,
    string PublishedAtRaw, string FooterTimeRaw, DateTime? PublishedAt, DateTime? FooterTime, string Status,
    string StatusLabel, string? Error, DateTime FetchedAt, DateTime? DetailFetchedAt, int Attempts, int MatchedCount,
    string MatchStatus, string MatchStatusLabel);
public sealed record ProductAnnouncementRecords(IReadOnlyList<ProductAnnouncementRecord> Items, long Total, int Page, int PageSize, int TotalPages);

/// <summary>公告台账、持久列表断点、详情待办与正式版本回填共用一个权威后台任务。</summary>
public sealed class ProductAnnouncementSyncService(MongoDbContext db, IHttpClientFactory clients,
    ILogger<ProductAnnouncementSyncService> logger)
{
    private static readonly TimeSpan Lease = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan Retry = TimeSpan.FromMinutes(15);
    private readonly string owner = Guid.NewGuid().ToString("N");
    private FilterDefinition<ProductAnnouncementSync> Owned(string runId) =>
        Builders<ProductAnnouncementSync>.Filter.Where(x => x.Id == ProductAnnouncementSync.SingletonId && x.RunId == runId && x.LeaseOwner == owner);
    private Task<ProductAnnouncementSync> ReadAsync() => db.ProductAnnouncementSyncs.Find(x => x.Id == ProductAnnouncementSync.SingletonId).FirstOrDefaultAsync();

    public async Task<ProductAnnouncementSyncStatus> StatusAsync()
    {
        var state = await ReadAsync() ?? new();
        var counts = await Task.WhenAll(
            db.ProductAnnouncements.CountDocumentsAsync(FilterDefinition<ProductAnnouncement>.Empty),
            db.ProductAnnouncements.CountDocumentsAsync(x => x.DetailStatus == "succeeded"),
            db.ProductAnnouncements.CountDocumentsAsync(x => x.DetailStatus == "failed"),
            db.ProductAnnouncements.CountDocumentsAsync(x => x.MatchStatus == "matched"));
        return new(state.Status, state.RunId, state.Message, state.Pages, state.Discovered, state.Updated, state.Conflicts,
            state.LastSuccessAt, state.NextRunAt, state.CalendarError, counts[0], counts[1], counts[2], counts[3],
            counts[0] - counts[1] - counts[2], Math.Max(1, state.NextPage), state.ListingComplete);
    }

    public async Task<ProductAnnouncementRecords> RecordsAsync(int page = 1, int pageSize = 20, bool failedOnly = false, string? search = null)
    {
        page = Math.Clamp(page, 1, 100000); pageSize = Math.Clamp(pageSize, 1, 100);
        var f = Builders<ProductAnnouncement>.Filter;
        var filter = failedOnly ? f.Eq(x => x.DetailStatus, "failed") : f.Empty;
        if (!string.IsNullOrWhiteSpace(search))
        {
            var trimmed = search.Trim();
            var query = new BsonRegularExpression(Regex.Escape(trimmed[..Math.Min(trimmed.Length, 100)]), "i");
            filter &= f.Or(f.Regex(x => x.Title, query), f.Regex(x => x.ApplicationName, query), f.Regex(x => x.Version, query));
        }
        var total = await db.ProductAnnouncements.CountDocumentsAsync(filter);
        var items = await db.ProductAnnouncements.Find(filter).SortByDescending(x => x.FetchedAt).ThenBy(x => x.Id)
            .Skip((page - 1) * pageSize).Limit(pageSize).ToListAsync();
        return new(items.Select(Record).ToList(), total, page, pageSize, (int)Math.Ceiling(total / (double)pageSize));
    }

    private static ProductAnnouncementRecord Record(ProductAnnouncement item)
    {
        if (string.IsNullOrWhiteSpace(item.ApplicationName) || string.IsNullOrWhiteSpace(item.Version)) ProductAnnouncementSource.EnrichTitle(item);
        var label = item.DetailStatus switch { "succeeded" => "已抓取", "failed" => "抓取失败", "running" => "抓取中", _ => "待抓取" };
        var match = item.MatchStatus switch { "matched" => "已匹配", "unmatched" => "未匹配", "conflict" => "匹配冲突", _ => "待匹配" };
        return new(item.Id, item.Url, item.Title, item.ApplicationName, item.Version, item.PublishedAtRaw, item.FooterTimeRaw,
            item.PublishedAt, item.FooterTime, item.DetailStatus, label, item.LastError, item.FetchedAt, item.DetailFetchedAt,
            item.Attempts, item.MatchedCount, item.MatchStatus, match);
    }

    private async Task<ProductAnnouncementSync> EnsureAsync(DateTime now)
    {
        try
        {
            await db.ProductAnnouncementSyncs.UpdateOneAsync(x => x.Id == ProductAnnouncementSync.SingletonId,
                Builders<ProductAnnouncementSync>.Update.SetOnInsert(x => x.CreatedAt, now).SetOnInsert(x => x.Status, "idle")
                    .SetOnInsert(x => x.RunId, "").SetOnInsert(x => x.NextPage, 1).SetOnInsert(x => x.ListingComplete, false),
                new UpdateOptions { IsUpsert = true }, CancellationToken.None);
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey) { }
        return await ReadAsync();
    }

    public async Task<ProductAnnouncementSyncStatus> RequestAsync(string userId, DateTime now, string? month = null)
    {
        var state = await EnsureAsync(now);
        var filter = Builders<ProductAnnouncementSync>.Filter.Where(x => x.Id == ProductAnnouncementSync.SingletonId
            && x.Status != "queued" && x.Status != "running" && (x.FinishedAt == null || x.FinishedAt < now.AddMinutes(-1)));
        if (month != null) filter &= Builders<ProductAnnouncementSync>.Filter.Ne(x => x.CompletedMonth, month);
        var update = Builders<ProductAnnouncementSync>.Update
            .Set(x => x.Status, "queued").Set(x => x.RunId, Guid.NewGuid().ToString("N"))
            .Set(x => x.Trigger, month == null ? "manual" : "scheduled").Set(x => x.ScheduledMonth, month)
            .Set(x => x.RequestedBy, userId).Set(x => x.RequestedAt, now).Set(x => x.LeaseOwner, null).Set(x => x.LeaseUntil, null)
            .Set(x => x.Updated, 0).Set(x => x.Conflicts, 0).Set(x => x.Message, "已排队，将从保存的列表位置和详情待办继续。");
        if (state.ListingComplete) update = update.Set(x => x.ListingComplete, false).Set(x => x.NextPage, 1)
            .Set(x => x.ScanMode, "incremental").Set(x => x.Pages, 0).Set(x => x.Discovered, 0);
        await db.ProductAnnouncementSyncs.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
        return await StatusAsync();
    }

    /// <summary>只由权威 Worker 调用；文件随构建提供，不在启动时访问外部站点生成种子。</summary>
    public async Task InitializeFromSeedFileAsync(string baseDirectory, CancellationToken token)
    {
        var path = Path.Combine(baseDirectory, "Data", "product-announcements.initial.json");
        if (!File.Exists(path)) return;
        var bytes = await File.ReadAllBytesAsync(path, token);
        var hash = Convert.ToHexString(SHA256.HashData(bytes));
        if ((await ReadAsync())?.ImportedSeedHash == hash) return;
        var seed = JsonSerializer.Deserialize<ProductAnnouncementSeed>(bytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidDataException("公告初始化快照为空。");
        await ImportSeedAsync(seed, hash, token);
    }

    public async Task<int> ImportSeedAsync(ProductAnnouncementSeed seed, string hash, CancellationToken token = default)
    {
        if (seed.SchemaVersion != 1 || seed.SourceUrl.TrimEnd('/') != ProductAnnouncementSource.ListUrl || seed.Records.Count == 0)
            throw new InvalidDataException("公告初始化快照的来源或格式无效。");
        var full = seed.ScanCompleted && seed.ExpectedPages > 0 && seed.PagesScanned == seed.ExpectedPages;
        if (seed.ScanCompleted && !full) throw new InvalidDataException("公告初始化快照的完整扫描证据不一致。");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in seed.Records)
        {
            if (!ProductAnnouncementSource.TryAnnouncementUrl(item.Url, out var uri) || string.IsNullOrWhiteSpace(item.Title)
                || !ids.Add(uri.Segments[^1])) throw new InvalidDataException("公告初始化记录存在无效地址、空标题或重复公告。");
            item.Id = uri.Segments[^1]; item.Url = uri.GetLeftPart(UriPartial.Path);
            if (item.DetailStatus is not ("succeeded" or "failed" or "pending")) throw new InvalidDataException("公告初始化详情状态无效。");
            ProductAnnouncementSource.EnrichTitle(item);
            item.ApplicationName = ProductAnnouncementSource.ApplicationKey(item.ApplicationName);
            item.Version = ProductAnnouncementSource.VersionKey(item.Version) ?? "";
        }
        var state = await EnsureAsync(DateTime.UtcNow);
        if (state.ImportedSeedHash == hash) return 0;
        var added = 0;
        foreach (var item in seed.Records)
        {
            token.ThrowIfCancellationRequested();
            var existing = await db.ProductAnnouncements.Find(x => x.Id == item.Id).FirstOrDefaultAsync(token);
            if (existing?.DetailStatus == "succeeded") continue;
            item.PublishedAt = ProductAnnouncementSource.ParseSourceTime(item.PublishedAtRaw);
            item.FooterTime = ProductAnnouncementSource.ParseSourceTime(item.FooterTimeRaw);
            item.DetailFetchedAt = item.DetailStatus == "succeeded" ? item.FetchedAt : null;
            item.Committed = full || existing?.Committed == true;
            item.Attempts = Math.Max(item.Attempts, existing?.Attempts ?? 0);
            if (existing != null)
            {
                if (string.IsNullOrWhiteSpace(item.PublishedAtRaw)) { item.PublishedAtRaw = existing.PublishedAtRaw; item.PublishedAt = existing.PublishedAt; }
                if (string.IsNullOrWhiteSpace(item.FooterTimeRaw)) { item.FooterTimeRaw = existing.FooterTimeRaw; item.FooterTime = existing.FooterTime; }
                item.MatchStatus = existing.MatchStatus; item.MatchedCount = existing.MatchedCount;
            }
            var result = await db.ProductAnnouncements.ReplaceOneAsync(x => x.Id == item.Id && x.DetailStatus != "succeeded", item,
                new ReplaceOptions { IsUpsert = existing == null }, CancellationToken.None);
            if (result.UpsertedId != null) added++;
        }
        var update = Builders<ProductAnnouncementSync>.Update.Set(x => x.ImportedSeedHash, hash).Set(x => x.SeedImportedAt, DateTime.UtcNow);
        if (state.Status is not ("queued" or "running"))
        {
            update = update.Set(x => x.Status, "queued").Set(x => x.RunId, Guid.NewGuid().ToString("N"))
                .Set(x => x.Trigger, "initial-seed").Set(x => x.RequestedBy, "system").Set(x => x.RequestedAt, DateTime.UtcNow)
                .Set(x => x.LeaseOwner, null).Set(x => x.LeaseUntil, null)
                .Set(x => x.Message, full ? "公告全量快照已导入，正在匹配正式版本。" : "公告部分快照已导入，将继续扫描未完成列表。");
            if (full && state.NextPage <= 1 && state.LastSuccessAt == null)
                update = update.Set(x => x.ListingComplete, true).Set(x => x.Pages, seed.PagesScanned).Set(x => x.NextPage, seed.PagesScanned + 1);
        }
        var seedFilter = state.Status is "queued" or "running"
            ? Builders<ProductAnnouncementSync>.Filter.Where(x => x.Id == ProductAnnouncementSync.SingletonId && x.RunId == state.RunId && x.Status == state.Status)
            : Builders<ProductAnnouncementSync>.Filter.Where(x => x.Id == ProductAnnouncementSync.SingletonId && x.Status != "queued" && x.Status != "running");
        await db.ProductAnnouncementSyncs.UpdateOneAsync(seedFilter, update, cancellationToken: CancellationToken.None);
        return added;
    }

    public async Task TickAsync(DateTime now, CancellationToken stoppingToken)
    {
        var state = await ReadAsync() ?? await EnsureAsync(now);
        if (state.Status is not "queued" and not "running")
        {
            if (state.CalendarRetryAt > now && (state.CalendarError != null || state.NextRunAt == null || state.NextRunAt > now)) return;
            await ScheduleAsync(state, now, stoppingToken);
        }
        var acquired = await db.ProductAnnouncementSyncs.FindOneAndUpdateAsync(
            Builders<ProductAnnouncementSync>.Filter.Where(x => x.Id == ProductAnnouncementSync.SingletonId
                && (x.Status == "queued" || x.Status == "running") && (x.LeaseUntil == null || x.LeaseUntil < now)),
            Builders<ProductAnnouncementSync>.Update.Set(x => x.Status, "running").Set(x => x.LeaseOwner, owner)
                .Set(x => x.LeaseUntil, now + Lease).Set(x => x.Message, "正在恢复公告抓取位置。"),
            new FindOneAndUpdateOptions<ProductAnnouncementSync> { ReturnDocument = ReturnDocument.After }, CancellationToken.None);
        if (acquired == null) return;
        try
        {
            await ExecuteAsync(acquired, stoppingToken);
            var completed = Builders<ProductAnnouncementSync>.Update.Set(x => x.Status, "succeeded")
                .Set(x => x.LastSuccessAt, DateTime.UtcNow).Set(x => x.FinishedAt, DateTime.UtcNow)
                .Set(x => x.LeaseOwner, null).Set(x => x.LeaseUntil, null);
            if (acquired.ScheduledMonth != null) completed = completed.Set(x => x.CompletedMonth, acquired.ScheduledMonth);
            await db.ProductAnnouncementSyncs.UpdateOneAsync(Owned(acquired.RunId), completed, cancellationToken: CancellationToken.None);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            await db.ProductAnnouncementSyncs.UpdateOneAsync(Owned(acquired.RunId), Builders<ProductAnnouncementSync>.Update
                .Set(x => x.Status, "queued").Set(x => x.LeaseOwner, null).Set(x => x.LeaseUntil, null)
                .Set(x => x.Message, "抓取位置与详情待办已保存，服务恢复后自动继续。"), cancellationToken: CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "公告更新未完成，列表游标与逐条结果已保存 RunId={RunId}", acquired.RunId);
            await db.ProductAnnouncementSyncs.UpdateOneAsync(Owned(acquired.RunId), Builders<ProductAnnouncementSync>.Update
                .Set(x => x.Status, "failed").Set(x => x.FinishedAt, DateTime.UtcNow)
                .Set(x => x.CalendarRetryAt, DateTime.UtcNow + Retry).Set(x => x.LeaseOwner, null).Set(x => x.LeaseUntil, null)
                .Set(x => x.Message, FailureMessage(ex.InnerException ?? ex, true)), cancellationToken: CancellationToken.None);
        }
    }

    private async Task RenewAsync(string runId, string message)
    {
        var result = await db.ProductAnnouncementSyncs.UpdateOneAsync(Owned(runId), Builders<ProductAnnouncementSync>.Update
            .Set(x => x.LeaseUntil, DateTime.UtcNow + Lease).Set(x => x.Message, message), cancellationToken: CancellationToken.None);
        if (result.MatchedCount == 0) throw new InvalidOperationException("公告任务租约已由其他实例接管。");
    }

    private Task<T> ReadPublicAsync<T>(string url, string runId, string operation, int attempt, Func<string, T> parse, CancellationToken token) =>
        new ProductAnnouncementHttpAudit(db, logger).ReadAsync(clients, url, runId, operation, attempt, parse, token);

    private static string FailureMessage(Exception error, bool listing)
    {
        var recovery = listing ? "已保存列表断点，请稍后点击更新公告继续。" : "其他公告会继续处理，请稍后更新公告重试该条。";
        var reason = error switch
        {
            OperationCanceledException => "公告站响应超时；",
            HttpRequestException http when http.StatusCode == null => "公告站连接失败；",
            HttpRequestException => "公告站返回异常；",
            InvalidOperationException when error.Message.StartsWith("公告响应审计未能保存", StringComparison.Ordinal) => "公告响应审计保存失败；",
            InvalidDataException when error.Message.Contains("未识别", StringComparison.Ordinal)
                || error.Message.Contains("没有可识别", StringComparison.Ordinal) => listing ? "公告列表格式未识别；" : "公告详情格式未识别；",
            InvalidDataException => "公告响应内容不完整或超出读取范围；",
            MongoException => "公告记录保存失败；",
            _ => "公告抓取未完成；",
        };
        return reason + recovery;
    }

    private async Task ExecuteAsync(ProductAnnouncementSync state, CancellationToken token)
    {
        Exception? listingError = null;
        try { if (!state.ListingComplete) await ScanListAsync(state, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception ex) { listingError = ex; logger.LogWarning(ex, "公告列表在第 {Page} 页暂停，先处理已发现详情", state.NextPage); }
        await FetchDetailsAsync(state, token);
        if (listingError != null) throw new InvalidDataException("公告列表尚未扫描完成。", listingError);
        await MatchVersionsAsync(state.RunId, token);
        var status = await StatusAsync();
        await db.ProductAnnouncementSyncs.UpdateOneAsync(Owned(state.RunId), Builders<ProductAnnouncementSync>.Update
            .Set(x => x.Message, $"公告更新完成：共 {status.Total} 条，详情成功 {status.DetailSucceeded} 条，失败 {status.Failed} 条，已匹配 {status.Matched} 条；回填 {status.Updated} 条正式版本。"), cancellationToken: CancellationToken.None);
    }

    private async Task ScanListAsync(ProductAnnouncementSync state, CancellationToken token)
    {
        for (var page = Math.Max(1, state.NextPage); page <= 1000; page++)
        {
            token.ThrowIfCancellationRequested();
            await RenewAsync(state.RunId, $"正在读取第 {page} 页公告，列表位置实时保存。");
            var parsed = await ReadPublicAsync(ProductAnnouncementSource.ListUrl + (page == 1 ? "" : $"?page={page}"), state.RunId,
                "list-page-" + page, 1, html => ProductAnnouncementSource.ParsePage(html, page), token);
            var atFrontier = state.ScanMode == "incremental";
            foreach (var item in parsed.Items)
            {
                var previous = await db.ProductAnnouncements.Find(x => x.Id == item.Id).FirstOrDefaultAsync(token);
                atFrontier &= previous?.Committed == true && previous.DetailStatus == "succeeded";
                var result = await db.ProductAnnouncements.UpdateOneAsync(x => x.Id == item.Id, Builders<ProductAnnouncement>.Update
                    .Set(x => x.Title, item.Title).Set(x => x.Url, item.Url).Set(x => x.ApplicationName, item.ApplicationName)
                    .Set(x => x.Version, item.Version).Set(x => x.SourcePage, page).Set(x => x.FetchedAt, DateTime.UtcNow)
                    .SetOnInsert(x => x.DetailStatus, "pending").SetOnInsert(x => x.Committed, false),
                    new UpdateOptions { IsUpsert = true }, CancellationToken.None);
                if (result.UpsertedId != null) state.Discovered++;
            }
            // 仅已完成全量扫描后的增量任务可在整页成功前沿停止；混排页先处理完再判断。
            state.Pages = page; state.NextPage = page + 1; state.ListingComplete = atFrontier || !parsed.HasNext;
            await db.ProductAnnouncementSyncs.UpdateOneAsync(Owned(state.RunId), Builders<ProductAnnouncementSync>.Update
                .Set(x => x.Pages, page).Set(x => x.NextPage, page + 1).Set(x => x.Discovered, state.Discovered)
                .Set(x => x.ListingComplete, state.ListingComplete), cancellationToken: CancellationToken.None);
            if (state.ListingComplete)
            {
                await db.ProductAnnouncements.UpdateManyAsync(x => !x.Committed, Builders<ProductAnnouncement>.Update.Set(x => x.Committed, true), cancellationToken: CancellationToken.None);
                return;
            }
        }
        throw new InvalidDataException("公告列表超出页数保护范围，已保留断点。");
    }

    private async Task FetchDetailsAsync(ProductAnnouncementSync state, CancellationToken token)
    {
        var pending = await db.ProductAnnouncements.Find(x => x.DetailStatus != "succeeded").SortBy(x => x.SourcePage).ThenBy(x => x.Id).ToListAsync(token);
        foreach (var item in pending)
        {
            token.ThrowIfCancellationRequested();
            await RenewAsync(state.RunId, $"正在抓取公告详情：{item.Title}");
            var claimed = await db.ProductAnnouncements.FindOneAndUpdateAsync(
                Builders<ProductAnnouncement>.Filter.Where(x => x.Id == item.Id && x.DetailStatus != "succeeded"),
                Builders<ProductAnnouncement>.Update.Set(x => x.DetailStatus, "running").Set(x => x.LastAttemptAt, DateTime.UtcNow).Inc(x => x.Attempts, 1),
                new FindOneAndUpdateOptions<ProductAnnouncement> { ReturnDocument = ReturnDocument.After }, CancellationToken.None);
            if (claimed == null) continue;
            try
            {
                if (!ProductAnnouncementSource.TryAnnouncementUrl(item.Url, out _)) throw new InvalidDataException("公告地址不属于指定来源。");
                var detail = await ReadPublicAsync(item.Url, state.RunId, "detail-" + item.Id, claimed.Attempts,
                    html => ProductAnnouncementSource.ParseDetail(html, item.Title), token);
                await db.ProductAnnouncements.UpdateOneAsync(x => x.Id == item.Id, Builders<ProductAnnouncement>.Update
                    .Set(x => x.PublishedAtRaw, detail.PublishedAtRaw).Set(x => x.FooterTimeRaw, detail.FooterTimeRaw)
                    .Set(x => x.PublishedAt, ProductAnnouncementSource.ParseSourceTime(detail.PublishedAtRaw))
                    .Set(x => x.FooterTime, ProductAnnouncementSource.ParseSourceTime(detail.FooterTimeRaw))
                    .Set(x => x.DetailStatus, "succeeded").Set(x => x.LastError, null).Set(x => x.DetailFetchedAt, DateTime.UtcNow), cancellationToken: CancellationToken.None);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "公告详情未完成 AnnouncementId={Id} RunId={RunId}", item.Id, state.RunId);
                await db.ProductAnnouncements.UpdateOneAsync(x => x.Id == item.Id, Builders<ProductAnnouncement>.Update
                    .Set(x => x.DetailStatus, "failed").Set(x => x.LastError, FailureMessage(ex, false)), cancellationToken: CancellationToken.None);
            }
        }
    }

    private async Task MatchVersionsAsync(string runId, CancellationToken token)
    {
        var cached = await db.ProductAnnouncements.Find(FilterDefinition<ProductAnnouncement>.Empty).ToListAsync(token);
        foreach (var item in cached) if (string.IsNullOrWhiteSpace(item.ApplicationName) || string.IsNullOrWhiteSpace(item.Version)) ProductAnnouncementSource.EnrichTitle(item);
        string? PostKey(ProductAnnouncement item) => string.IsNullOrWhiteSpace(item.ApplicationName) || ProductAnnouncementSource.VersionKey(item.Version) == null
            ? null : ProductAnnouncementSource.ApplicationKey(item.ApplicationName) + ":" + ProductAnnouncementSource.VersionKey(item.Version);
        var posts = cached.Where(x => PostKey(x) != null).GroupBy(x => PostKey(x)!).ToDictionary(x => x.Key, x => x.ToList());
        var products = (await db.Products.Find(x => !x.IsDeleted).ToListAsync(token)).ToDictionary(x => x.Id, x => x.Name);
        var versions = await ProductVersionListReader.ReadReleasesAsync(db, null, "", true);
        string? Key(ProductVersionListRow<ProductRelease> row)
        {
            var app = ProductAnnouncementSource.ApplicationKey(string.IsNullOrWhiteSpace(row.Record.AppName) ? products.GetValueOrDefault(row.Record.ProductId) : row.Record.AppName);
            var code = ProductAnnouncementSource.VersionKey(row.Record.VCode);
            return app.Length == 0 || code == null ? null : app + ":" + code;
        }
        var groups = versions.Items.Where(x => Key(x) != null).GroupBy(x => Key(x)!).ToDictionary(x => x.Key, x => x.ToList());
        var updated = 0; var conflicts = 0; var conflictKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in cached)
        {
            token.ThrowIfCancellationRequested();
            var matchStatus = "unmatched"; var matchedCount = 0; var key = PostKey(item);
            if (key != null && groups.TryGetValue(key, out var rows))
            {
                if (rows.Count != 1 || posts[key].Count != 1) { matchStatus = "conflict"; if (conflictKeys.Add(key)) conflicts++; }
                else
                {
                    var row = rows[0];
                    if (!string.IsNullOrWhiteSpace(row.Record.AnnouncementUrl) && row.Record.AnnouncementUrl != item.Url) { matchStatus = "conflict"; if (conflictKeys.Add(key)) conflicts++; }
                    else
                    {
                        await RenewAsync(runId, $"正在按应用和 V 版本号匹配，已回填 {updated} 条正式版本。");
                        UpdateResult? result = null;
                        if (row.Record.AnnouncementUrl != item.Url)
                        {
                            if (row.LegacyRegistration is { } old)
                                result = await db.VersionRegistrations.UpdateOneAsync(x => x.Id == old.Id && x.Kind == VersionRegistrationKind.Formal
                                    && x.Code == old.Code && x.ApplicationName == old.ApplicationName && x.AnnouncementUrl == old.AnnouncementUrl,
                                    Builders<VersionRegistration>.Update.Set(x => x.AnnouncementUrl, item.Url), cancellationToken: CancellationToken.None);
                            else
                            {
                                var record = row.Record;
                                result = await db.ProductReleases.UpdateOneAsync(x => x.Id == record.Id && !x.IsDeleted && x.VCode == record.VCode
                                    && x.ProductId == record.ProductId && x.AppName == record.AppName && x.AnnouncementUrl == record.AnnouncementUrl,
                                    Builders<ProductRelease>.Update.Set(x => x.AnnouncementUrl, item.Url), cancellationToken: CancellationToken.None);
                            }
                        }
                        if (result == null || result.MatchedCount == 1) { matchStatus = "matched"; matchedCount = 1; updated += (int)(result?.ModifiedCount ?? 0); }
                        else { matchStatus = "conflict"; if (conflictKeys.Add(key)) conflicts++; }
                    }
                }
            }
            await db.ProductAnnouncements.UpdateOneAsync(x => x.Id == item.Id, Builders<ProductAnnouncement>.Update
                .Set(x => x.ApplicationName, item.ApplicationName).Set(x => x.Version, item.Version)
                .Set(x => x.MatchStatus, matchStatus).Set(x => x.MatchedCount, matchedCount), cancellationToken: CancellationToken.None);
        }
        await db.ProductAnnouncementSyncs.UpdateOneAsync(Owned(runId), Builders<ProductAnnouncementSync>.Update
            .Set(x => x.Updated, updated).Set(x => x.Conflicts, conflicts), cancellationToken: CancellationToken.None);
    }

    private async Task<ProductWorkdayCalendar> CalendarAsync(int year, CancellationToken token)
    {
        var cached = await db.ProductWorkdayCalendars.Find(x => x.Id == year.ToString()).FirstOrDefaultAsync(token);
        if (cached != null && cached.FetchedAt > DateTime.UtcNow.AddDays(-1)) return cached;
        try
        {
            var calendar = await ReadPublicAsync($"https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json", "calendar-" + year,
                "workday-calendar", 1, json => ProductAnnouncementSource.ParseCalendar(json, year), token);
            await db.ProductWorkdayCalendars.ReplaceOneAsync(x => x.Id == calendar.Id, calendar, new ReplaceOptions { IsUpsert = true }, CancellationToken.None);
            return calendar;
        }
        catch (Exception ex) when (cached != null && ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "法定日历暂不可刷新，沿用已验证的 {Year} 年缓存", year);
            return cached;
        }
    }

    private async Task ScheduleAsync(ProductAnnouncementSync state, DateTime now, CancellationToken token)
    {
        try
        {
            var beijing = now.AddHours(8);
            var calendar = await CalendarAsync(beijing.Year, token);
            var slot = ProductAnnouncementSource.MonthlySlotUtc(beijing.Year, beijing.Month, calendar);
            var month = beijing.ToString("yyyy-MM");
            if (slot >= state.CreatedAt && slot <= now && state.CompletedMonth != month) await RequestAsync("system", now, month);
            var next = new DateTime(beijing.Year, beijing.Month, 1).AddMonths(slot <= now ? 1 : 0);
            var nextCalendar = next.Year == calendar.Year ? calendar : await CalendarAsync(next.Year, token);
            await db.ProductAnnouncementSyncs.UpdateOneAsync(x => x.Id == ProductAnnouncementSync.SingletonId,
                Builders<ProductAnnouncementSync>.Update.Set(x => x.NextRunAt, ProductAnnouncementSource.MonthlySlotUtc(next.Year, next.Month, nextCalendar))
                    .Set(x => x.CalendarError, null).Set(x => x.CalendarRetryAt, now.AddHours(1)), cancellationToken: CancellationToken.None);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "法定工作日调度暂缓，不降级为普通周一至周五");
            await db.ProductAnnouncementSyncs.UpdateOneAsync(x => x.Id == ProductAnnouncementSync.SingletonId,
                Builders<ProductAnnouncementSync>.Update.Set(x => x.CalendarError, "法定工作日日历暂不可用，定时更新将重试；仍可手动更新公告。")
                    .Set(x => x.CalendarRetryAt, now.AddHours(1)), cancellationToken: CancellationToken.None);
        }
    }
}
