using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed record ProductAnnouncementSyncStatus(string Status, string RunId, string Message, int Pages,
    int Discovered, int Updated, int Conflicts, DateTime? LastSuccessAt, DateTime? NextRunAt, string? CalendarError);

/// <summary>手动与月度任务共用的持久队列、成功水位和公告回填。</summary>
public sealed class ProductAnnouncementSyncService(MongoDbContext db, IHttpClientFactory clients,
    ILogger<ProductAnnouncementSyncService> logger)
{
    private static readonly TimeSpan Lease = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan Retry = TimeSpan.FromMinutes(15);
    private readonly string owner = Guid.NewGuid().ToString("N");
    private FilterDefinition<ProductAnnouncementSync> Owned(string runId) =>
        Builders<ProductAnnouncementSync>.Filter.Where(x => x.Id == ProductAnnouncementSync.SingletonId && x.RunId == runId && x.LeaseOwner == owner);

    public async Task<ProductAnnouncementSyncStatus> StatusAsync() => View(await ReadAsync() ?? new());

    private static ProductAnnouncementSyncStatus View(ProductAnnouncementSync state) => new(state.Status, state.RunId,
        state.Message, state.Pages, state.Discovered, state.Updated, state.Conflicts, state.LastSuccessAt, state.NextRunAt, state.CalendarError);

    private Task<ProductAnnouncementSync> ReadAsync() => db.ProductAnnouncementSyncs.Find(x => x.Id == ProductAnnouncementSync.SingletonId).FirstOrDefaultAsync();

    private async Task<ProductAnnouncementSync> EnsureAsync(DateTime now)
    {
        try
        {
            await db.ProductAnnouncementSyncs.UpdateOneAsync(x => x.Id == ProductAnnouncementSync.SingletonId,
                Builders<ProductAnnouncementSync>.Update.SetOnInsert(x => x.CreatedAt, now), new UpdateOptions { IsUpsert = true }, CancellationToken.None);
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey) { }
        return await ReadAsync();
    }

    public async Task<ProductAnnouncementSyncStatus> RequestAsync(string userId, DateTime now, string? month = null)
    {
        await EnsureAsync(now);
        var filter = Builders<ProductAnnouncementSync>.Filter.Where(x => x.Id == ProductAnnouncementSync.SingletonId
            && x.Status != "queued" && x.Status != "running" && (x.FinishedAt == null || x.FinishedAt < now.AddMinutes(-1)));
        if (month != null) filter &= Builders<ProductAnnouncementSync>.Filter.Ne(x => x.CompletedMonth, month);
        await db.ProductAnnouncementSyncs.UpdateOneAsync(filter, Builders<ProductAnnouncementSync>.Update
            .Set(x => x.Status, "queued").Set(x => x.RunId, Guid.NewGuid().ToString("N"))
            .Set(x => x.Trigger, month == null ? "manual" : "scheduled").Set(x => x.ScheduledMonth, month)
            .Set(x => x.RequestedBy, userId).Set(x => x.RequestedAt, now).Set(x => x.LeaseOwner, null).Set(x => x.LeaseUntil, null)
            .Set(x => x.Pages, 0).Set(x => x.Discovered, 0).Set(x => x.Updated, 0).Set(x => x.Conflicts, 0)
            .Set(x => x.Message, "已排队，正在准备更新公告。"), cancellationToken: CancellationToken.None);
        return View(await ReadAsync());
    }

    /// <summary>由唯一权威部署轮询；数据库条件租约跨实例互斥，过期任务自动恢复。</summary>
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
                .Set(x => x.LeaseUntil, now + Lease).Set(x => x.Message, "正在读取公告列表。"),
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
                .Set(x => x.Message, "服务重启后自动继续，已保存公告与版本记录。"), cancellationToken: CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "版本公告更新未完成，保留成功水位以便重试");
            await db.ProductAnnouncementSyncs.UpdateOneAsync(Owned(acquired.RunId), Builders<ProductAnnouncementSync>.Update
                .Set(x => x.Status, "failed").Set(x => x.FinishedAt, DateTime.UtcNow)
                .Set(x => x.CalendarRetryAt, DateTime.UtcNow + Retry).Set(x => x.LeaseOwner, null).Set(x => x.LeaseUntil, null)
                .Set(x => x.Message, "公告更新未完成，已保存抓取位置和原有数据；请稍后点击更新公告重试。"), cancellationToken: CancellationToken.None);
        }
    }

    private async Task RenewAsync(string runId, string message, int pages, int discovered)
    {
        var result = await db.ProductAnnouncementSyncs.UpdateOneAsync(Owned(runId), Builders<ProductAnnouncementSync>.Update
            .Set(x => x.LeaseUntil, DateTime.UtcNow + Lease).Set(x => x.Message, message)
            .Set(x => x.Pages, pages).Set(x => x.Discovered, discovered), cancellationToken: CancellationToken.None);
        if (result.MatchedCount == 0) throw new InvalidOperationException("公告任务租约已由其他实例接管。");
    }

    private async Task<string> ReadPublicAsync(string url, CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(25));
        token = timeout.Token;
        using var client = clients.CreateClient("ProductAnnouncements");
        client.DefaultRequestHeaders.UserAgent.ParseAdd("MAP-VersionAnnouncements/1.0");
        client.Timeout = TimeSpan.FromSeconds(25);
        using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, token);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > 2 * 1024 * 1024) throw new InvalidDataException("公开源响应过大。");
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int count;
        while ((count = await stream.ReadAsync(chunk, token)) != 0)
        {
            if (buffer.Length + count > 2 * 1024 * 1024) throw new InvalidDataException("公开源响应过大。");
            buffer.Write(chunk, 0, count);
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private async Task ExecuteAsync(ProductAnnouncementSync state, CancellationToken token)
    {
        var discovered = 0;
        var page = 1;
        var finished = false;
        for (; page <= 1000; page++)
        {
            token.ThrowIfCancellationRequested();
            await RenewAsync(state.RunId, $"正在读取第 {page} 页公告，已发现 {discovered} 条新公告。", page - 1, discovered);
            var parsed = ProductAnnouncementSource.ParsePage(await ReadPublicAsync(ProductAnnouncementSource.ListUrl + (page == 1 ? "" : $"?page={page}"), token), page);
            foreach (var item in parsed.Items)
            {
                var previous = await db.ProductAnnouncements.Find(x => x.Id == item.Id).FirstOrDefaultAsync(token);
                if (previous?.Committed == true) { finished = true; break; }
                await db.ProductAnnouncements.UpdateOneAsync(x => x.Id == item.Id, Builders<ProductAnnouncement>.Update
                    .Set(x => x.Title, item.Title).Set(x => x.Url, item.Url).Set(x => x.FetchedAt, DateTime.UtcNow)
                    .SetOnInsert(x => x.Committed, false), new UpdateOptions { IsUpsert = true }, CancellationToken.None);
                discovered++;
            }
            if (finished || !parsed.HasNext) { finished = true; break; }
        }
        if (!finished) throw new InvalidDataException("公告页数超出保护范围，未推进成功水位。");
        await RenewAsync(state.RunId, "正在按应用和正式版本号匹配公告。", page, discovered);
        // 到达成功前沿后才提交；失败半途留下的缓存不充当停止条件。
        await db.ProductAnnouncements.UpdateManyAsync(x => !x.Committed, Builders<ProductAnnouncement>.Update.Set(x => x.Committed, true), cancellationToken: CancellationToken.None);
        var cached = await db.ProductAnnouncements.Find(x => x.Committed).ToListAsync(token);
        var posts = cached.Select(x => (Key: ProductAnnouncementSource.TitleKey(x.Title), Post: x)).Where(x => x.Key != null)
            .GroupBy(x => x.Key!).ToDictionary(x => x.Key, x => x.Select(y => y.Post).ToList());
        var products = (await db.Products.Find(x => !x.IsDeleted).ToListAsync(token)).ToDictionary(x => x.Id, x => x.Name);
        var versions = await ProductVersionListReader.ReadReleasesAsync(db, null, "", true);
        string? Key(ProductVersionListRow<ProductRelease> row)
        {
            var app = ProductAnnouncementSource.ApplicationKey(string.IsNullOrWhiteSpace(row.Record.AppName)
                ? products.GetValueOrDefault(row.Record.ProductId) : row.Record.AppName);
            var code = ProductAnnouncementSource.VersionKey(row.Record.VCode);
            return app.Length == 0 || code == null ? null : app + ":" + code;
        }
        var updated = 0;
        var conflicts = 0;
        foreach (var group in versions.Items.Select(x => (Key: Key(x), Row: x)).Where(x => x.Key != null).GroupBy(x => x.Key!))
        {
            token.ThrowIfCancellationRequested();
            if (!posts.TryGetValue(group.Key, out var candidates)) continue;
            if (group.Count() != 1 || candidates.Count != 1) { conflicts++; continue; }
            var row = group.Single().Row;
            var url = candidates[0].Url;
            if (row.Record.AnnouncementUrl == url) continue;
            if (!string.IsNullOrWhiteSpace(row.Record.AnnouncementUrl)) { conflicts++; continue; }
            await RenewAsync(state.RunId, $"正在匹配公告，已更新 {updated} 条。", page, discovered);
            UpdateResult result;
            if (row.LegacyRegistration is { } old)
            {
                result = await db.VersionRegistrations.UpdateOneAsync(x => x.Id == old.Id && x.Kind == VersionRegistrationKind.Formal
                    && x.Code == old.Code && x.ApplicationName == old.ApplicationName && x.AnnouncementUrl == old.AnnouncementUrl,
                    Builders<VersionRegistration>.Update.Set(x => x.AnnouncementUrl, url), cancellationToken: CancellationToken.None);
            }
            else
            {
                var record = row.Record;
                result = await db.ProductReleases.UpdateOneAsync(x => x.Id == record.Id && !x.IsDeleted && x.VCode == record.VCode
                    && x.ProductId == record.ProductId && x.AppName == record.AppName && x.AnnouncementUrl == record.AnnouncementUrl,
                    Builders<ProductRelease>.Update.Set(x => x.AnnouncementUrl, url), cancellationToken: CancellationToken.None);
            }
            updated += (int)result.ModifiedCount;
        }
        await db.ProductAnnouncementSyncs.UpdateOneAsync(Owned(state.RunId), Builders<ProductAnnouncementSync>.Update
            .Set(x => x.Updated, updated).Set(x => x.Conflicts, conflicts)
            .Set(x => x.Message, $"公告更新完成：新增 {discovered} 条公告，回填 {updated} 条版本记录；{conflicts} 项存在歧义或地址冲突，原数据保留。"), cancellationToken: CancellationToken.None);
    }

    private async Task<ProductWorkdayCalendar> CalendarAsync(int year, CancellationToken token)
    {
        var cached = await db.ProductWorkdayCalendars.Find(x => x.Id == year.ToString()).FirstOrDefaultAsync(token);
        if (cached != null && cached.FetchedAt > DateTime.UtcNow.AddDays(-1)) return cached;
        try
        {
            var calendar = ProductAnnouncementSource.ParseCalendar(await ReadPublicAsync($"https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json", token), year);
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
            if (slot >= state.CreatedAt && slot <= now && state.CompletedMonth != month)
            {
                await RequestAsync("system", now, month);
            }
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
