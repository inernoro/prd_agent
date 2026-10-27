using System.Net;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductAnnouncementSyncTests
{
    private const string Official = "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm";
    private static string Page(string id, string title, int? next = null) => $"<a href='/945f/{id}'><b>{title}</b></a>" + (next == null ? "" : $"<a href='/945f?page={next}'>下一页</a>");
    private static string Detail(string title) => $"<h1>{title}</h1><div class='editor_js--paragraph editor_js--paragraph__align-right'>米多品牌域产品团队</div>"
        + "<div class='editor_js--paragraph editor_js--paragraph__align-right'>2024年4月2日</div>"
        + "<div class='flex items-center mt-10 text-xs text-gray-400'><svg></svg><div class='ml-1'>2024-08-07 </div></div>";

    [Fact]
    public void ParsesRealTitleShapesAndOnlySameOriginPagination()
    {
        var page = ProductAnnouncementSource.ParsePage(Page("6f4c", "互动营销V3.33.1（方案名发生变化）-上线公告", 2)
            + "<a href='https://evil.example/945f/steal'>互动营销V3.33.1</a>", 1);
        Assert.True(page.HasNext);
        Assert.Single(page.Items);
        Assert.Equal("互动营销:V3.33.1", ProductAnnouncementSource.TitleKey(page.Items[0].Title));
        Assert.Equal("品牌商后台基础:V4.26.2", ProductAnnouncementSource.TitleKey("品牌后台基础 V4.26.2（新增功能）-上线公告"));
        Assert.Equal("米多总平台:V3.14.1", ProductAnnouncementSource.TitleKey("米多星球V3.14.1(IMP配套方案)"));
        Assert.Equal("DCRM:V1.4.2", ProductAnnouncementSource.TitleKey("DCRMV1.4.2（改名）"));
        Assert.Null(ProductAnnouncementSource.TitleKey("2026.10.15功能优化小报"));
        Assert.Null(ProductAnnouncementSource.TitleKey("应用V1.0.0与V2.0.0"));
        Assert.Throws<InvalidDataException>(() => ProductAnnouncementSource.ParsePage("<h1>站点维护</h1>", 1));
    }

    [Fact]
    public void DetailKeepsDifferentBodyAndFooterDatesAndRejectsUnrelatedPage()
    {
        const string title = "互动营销V1.0.0（方案）";
        var detail = ProductAnnouncementSource.ParseDetail(Detail(title), title);
        Assert.Equal("2024年4月2日", detail.PublishedAtRaw);
        Assert.Equal("2024-08-07", detail.FooterTimeRaw);
        Assert.Equal(new DateTime(2024, 4, 1, 16, 0, 0, DateTimeKind.Utc), ProductAnnouncementSource.ParseSourceTime(detail.PublishedAtRaw));
        var spaced = ProductAnnouncementSource.ParseDetail(Detail(title).Replace("2024年4月2日", "2026 年 10 月 26 日"), title);
        Assert.Equal("2026 年 10 月 26 日", spaced.PublishedAtRaw);
        Assert.Equal(new DateTime(2026, 10, 25, 16, 0, 0, DateTimeKind.Utc), ProductAnnouncementSource.ParseSourceTime(spaced.PublishedAtRaw));
        Assert.Null(ProductAnnouncementSource.ParseSourceTime("未标明"));
        var absent = ProductAnnouncementSource.ParseDetail($"<h1>{title}</h1><p>2026-10-27只是正文示例</p>", title);
        Assert.Equal("", absent.PublishedAtRaw);
        Assert.Equal("", absent.FooterTimeRaw);
        Assert.Throws<InvalidDataException>(() => ProductAnnouncementSource.ParseDetail("<h1>维护中</h1>", title));
        Assert.False(ProductAnnouncementSource.TryAnnouncementUrl("https://other.example/945f/one", out _));
        Assert.False(ProductAnnouncementSource.TryAnnouncementUrl("https://secret@helper.weixin12315.com/945f/one", out _));
    }

    [Fact]
    public void ActualCab8UsesFinalUnalignedSignatureWithoutTakingBusinessDates()
    {
        const string title = "万能零售助手T3.7.5（新增AI小助手）-上线公告";
        var html = $"<h1>{title}</h1><div class='editor_js--paragraph'>业务日期示例：</div>"
            + "<div class='editor_js--paragraph'>2025年08月01日</div>"
            + "<div class='editor_js--paragraph'>米多品牌域产品团队</div>"
            + "<div class='editor_js--paragraph'>2025年09月05日</div>"
            + "<div class='editor_js--paragraph'><br></div>"
            + "<div class='flex items-center mt-10 text-xs text-gray-400'><svg></svg><div class='ml-1'>2025-09-11 </div></div>";
        var result = ProductAnnouncementSource.ParseDetail(html, title);
        Assert.Equal("2025年09月05日", result.PublishedAtRaw);
        Assert.Equal("2025-09-11", result.FooterTimeRaw);
        var withoutSignature = $"<h1>{title}</h1><div class='editor_js--paragraph'>2025年08月01日</div>"
            + "<div class='editor_js--paragraph'>这是功能说明而非落款</div>";
        Assert.Equal("", ProductAnnouncementSource.ParseDetail(withoutSignature, title).PublishedAtRaw);
    }

    [Theory]
    [InlineData("2022年12月29", 2022, 12, 29)]
    [InlineData("2021年07月21", 2021, 7, 21)]
    [InlineData("2021年6月22", 2021, 6, 22)]
    [InlineData("2021年05月19", 2021, 5, 19)]
    [InlineData("2018年07月06", 2018, 7, 6)]
    [InlineData("2018年03月30", 2018, 3, 30)]
    public void ActualDatesWithoutDaySuffixKeepRawAndParseToBeijingDate(string raw, int year, int month, int day)
    {
        const string title = "历史公告";
        var result = ProductAnnouncementSource.ParseDetail(Detail(title).Replace("2024年4月2日", raw), title);
        Assert.Equal(raw, result.PublishedAtRaw);
        Assert.Equal(new DateTime(year, month, day, 0, 0, 0, DateTimeKind.Utc).AddHours(-8), ProductAnnouncementSource.ParseSourceTime(raw));
    }

    [Fact]
    public void StatutoryHolidaysAndMakeupSundayDetermineFirstWorkdayAtBeijingEight()
    {
        var calendar = ProductAnnouncementSource.ParseCalendar($$"""{"year":2026,"papers":["{{Official}}"],"days":[{"date":"2026-01-01","isOffDay":true},{"date":"2026-01-02","isOffDay":true},{"date":"2026-01-03","isOffDay":true},{"date":"2026-01-04","isOffDay":false},{"date":"2026-05-01","isOffDay":true},{"date":"2026-05-04","isOffDay":true},{"date":"2026-05-05","isOffDay":true}]}""", 2026);
        Assert.Equal(new DateTime(2026, 1, 4, 0, 0, 0, DateTimeKind.Utc), ProductAnnouncementSource.MonthlySlotUtc(2026, 1, calendar));
        Assert.Equal(new DateTime(2026, 5, 6, 0, 0, 0, DateTimeKind.Utc), ProductAnnouncementSource.MonthlySlotUtc(2026, 5, calendar));
        Assert.Throws<InvalidDataException>(() => ProductAnnouncementSource.ParseCalendar("{\"year\":2026,\"papers\":[],\"days\":[]}", 2026));
    }

    [Fact]
    public async Task FullPaginationReusesSuccessfulDetailsAndRematchesLaterImportsWithoutChangingIssuance()
    {
        await using var f = new Fixture();
        f.Pages[1] = Page("new", "互动营销V3.33.1（新名称）-上线公告", 2);
        f.Pages[2] = Page("old", "品牌后台基础V4.26.2（旧名称）-上线公告");
        await f.Db.Products.InsertManyAsync(new[] { new Product { Id = "a", Name = "互动营销" }, new Product { Id = "b", Name = "品牌商后台基础" } });
        var released = DateTime.UtcNow.AddDays(-10);
        await f.Db.ProductReleases.InsertManyAsync(new[] {
            new ProductRelease { Id = "v", ProductId = "a", AppName = "互动营销", VCode = "V3.33.1", PlanName = "完全不同的旧方案名", ReleasedAt = released },
            new ProductRelease { Id = "other", ProductId = "b", AppName = "品牌商后台基础", VCode = "V3.33.1" },
        });
        await f.Run();
        Assert.Equal(new[] { 1, 2 }, f.Requests);
        var record = await f.Db.ProductReleases.Find(x => x.Id == "v").SingleAsync();
        Assert.Equal("https://helper.weixin12315.com/945f/new", record.AnnouncementUrl);
        Assert.Equal(released.ToString("s"), record.ReleasedAt!.Value.ToString("s"));
        Assert.Equal("announcement_pending", record.Status);
        Assert.Equal(2, f.DetailRequests.Count);
        var firstStatus = await f.Service.StatusAsync();
        var audits = await f.Db.ApiRequestLogs.Find(x => x.SessionId == firstStatus.RunId).ToListAsync();
        Assert.Equal(4, audits.Count);
        Assert.All(audits, log => {
            using var evidence = JsonDocument.Parse(log.ResponseBody!);
            Assert.True(evidence.RootElement.GetProperty("responseReceived").GetBoolean());
            Assert.True(evidence.RootElement.GetProperty("parseSucceeded").GetBoolean());
            Assert.Null(log.ErrorCode);
        });
        Assert.Null((await f.Db.ProductReleases.Find(x => x.Id == "other").SingleAsync()).AnnouncementUrl);
        await f.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration { Id = "later", Kind = "formal", ApplicationName = "品牌商后台基础", Code = "V4.26.2" });
        await f.Run();
        Assert.Equal(new[] { 1 }, f.Requests);
        Assert.Empty(f.DetailRequests);
        Assert.Equal("https://helper.weixin12315.com/945f/old", (await f.Db.VersionRegistrations.Find(x => x.Id == "later").SingleAsync()).AnnouncementUrl);
        var status = await f.Service.StatusAsync();
        Assert.Equal("succeeded", status.Status);
        Assert.Equal(0, status.Discovered);
        Assert.Equal(1, status.Updated);
        Assert.Equal(2, await f.Db.ProductAnnouncements.CountDocumentsAsync(x => x.Committed));
    }

    [Fact]
    public async Task PartialFailedCrawlNeverAdvancesWatermarkAndConflictsArePreserved()
    {
        await using var f = new Fixture();
        f.Pages[1] = Page("new", "互动营销V1.0.0（方案）", 2);
        await f.Run();
        Assert.Equal("failed", (await f.Service.StatusAsync()).Status);
        Assert.Equal(0, await f.Db.ProductAnnouncements.CountDocumentsAsync(x => x.Committed));
        Assert.Equal(2, (await f.Service.StatusAsync()).NextPage);
        Assert.Equal(new[] { "new" }, f.DetailRequests);
        f.Pages[2] = Page("ambiguous", "互动营销V1.0.0（另一个公告）");
        await f.Db.Products.InsertOneAsync(new Product { Id = "a", Name = "互动营销" });
        await f.Db.ProductReleases.InsertOneAsync(new ProductRelease { Id = "v", ProductId = "a", VCode = "V1.0.0", AnnouncementUrl = "https://original.example/notice" });
        await f.Run();
        Assert.Equal(new[] { 2 }, f.Requests);
        Assert.Equal(new[] { "ambiguous" }, f.DetailRequests);
        Assert.Equal(2, await f.Db.ProductAnnouncements.CountDocumentsAsync(x => x.Committed));
        Assert.Equal(1, (await f.Service.StatusAsync()).Conflicts);
        Assert.Equal("https://original.example/notice", (await f.Db.ProductReleases.Find(x => x.Id == "v").SingleAsync()).AnnouncementUrl);
    }

    [Fact]
    public async Task IncompleteListingNeverBackfillsBeforeLaterPageCanRevealAmbiguity()
    {
        await using var f = new Fixture();
        f.Pages[1] = Page("phase-one", "互动营销V1.0.0（一期）", 2);
        await f.Db.Products.InsertOneAsync(new Product { Id = "app", Name = "互动营销" });
        await f.Db.ProductReleases.InsertOneAsync(new ProductRelease { Id = "formal", ProductId = "app", AppName = "互动营销", VCode = "V1.0.0", Status = "released" });
        await f.Run();
        var interrupted = await f.Service.StatusAsync();
        Assert.Equal("failed", interrupted.Status); Assert.False(interrupted.ListingComplete); Assert.Equal(2, interrupted.NextPage);
        Assert.Equal(1, interrupted.DetailSucceeded);
        Assert.Null((await f.Db.ProductReleases.Find(x => x.Id == "formal").SingleAsync()).AnnouncementUrl);
        Assert.Equal(0, interrupted.Updated);
        f.Pages[2] = Page("phase-two", "互动营销V1.0.0（二期）");
        await f.Run();
        Assert.Equal(new[] { 2 }, f.Requests);
        Assert.Null((await f.Db.ProductReleases.Find(x => x.Id == "formal").SingleAsync()).AnnouncementUrl);
        Assert.Equal(1, (await f.Service.StatusAsync()).Conflicts);
        Assert.All((await f.Service.RecordsAsync()).Items, item => Assert.Equal("conflict", item.MatchStatus));
    }

    [Fact]
    public async Task QueueIsGlobalAndExpiredLeaseRecoversAfterRestart()
    {
        await using var f = new Fixture();
        f.Pages[1] = Page("one", "互动营销V1.0.0");
        var now = DateTime.UtcNow;
        var requests = await Task.WhenAll(Enumerable.Range(0, 6).Select(i => f.Service.RequestAsync("user" + i, now)));
        Assert.Single(requests.Select(x => x.RunId).Distinct());
        await f.Db.ProductAnnouncementSyncs.UpdateOneAsync(_ => true, Builders<ProductAnnouncementSync>.Update.Set(x => x.Status, "running")
            .Set(x => x.LeaseOwner, "dead-instance").Set(x => x.LeaseUntil, now.AddMinutes(-1)));
        await Task.WhenAll(f.Service.TickAsync(now, default), f.NewService().TickAsync(now, default));
        Assert.Single(f.Requests);
        Assert.Equal("succeeded", (await f.Service.StatusAsync()).Status);
    }

    [Fact]
    public async Task MonthlySlotIsNotRetroactiveAndRunsOnlyOnceAfterEight()
    {
        await using var f = new Fixture();
        f.Pages[1] = Page("one", "互动营销V1.0.0");
        await f.Db.ProductWorkdayCalendars.InsertOneAsync(new ProductWorkdayCalendar { Id = "2026", Year = 2026, Papers = new() { Official } });
        await f.Db.ProductAnnouncementSyncs.InsertOneAsync(new ProductAnnouncementSync { CreatedAt = new DateTime(2026, 9, 10, 0, 0, 0, DateTimeKind.Utc) });
        await f.Service.TickAsync(new DateTime(2026, 9, 20, 0, 0, 0, DateTimeKind.Utc), default);
        Assert.Empty(f.Requests);
        await f.Service.TickAsync(new DateTime(2026, 9, 30, 23, 59, 59, DateTimeKind.Utc), default);
        Assert.Empty(f.Requests);
        await f.Service.TickAsync(new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc), default);
        Assert.Single(f.Requests);
        await f.Service.TickAsync(new DateTime(2026, 10, 1, 0, 5, 0, DateTimeKind.Utc), default);
        Assert.Single(f.Requests);
        Assert.Equal("2026-10", (await f.Db.ProductAnnouncementSyncs.Find(_ => true).SingleAsync()).CompletedMonth);
    }

    [Fact]
    public async Task AdminPermissionAndDeploymentAuthorityAreBothRequiredForManualUpdate()
    {
        await using var f = new Fixture();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["CDS_PROJECT_ID"] = "preview" }).Build();
        ProductAgentController Controller(bool admin) => new(f.Db, NullLogger<ProductAgentController>.Instance, null!, null!, null!, null!, null!, null!) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[] {
                new Claim("sub", "me"), new Claim("permissions", admin ? AdminPermissionCatalog.ProductAgentAdmin : AdminPermissionCatalog.ProductAgentUse),
            }, "test")) } },
        };
        Assert.Equal(403, Assert.IsType<ObjectResult>(await Controller(false).UpdateAnnouncements(f.Service, configuration)).StatusCode);
        Assert.Equal(403, Assert.IsType<ObjectResult>(await Controller(false).GetAnnouncementRecords(f.Service)).StatusCode);
        Assert.IsType<ConflictObjectResult>(await Controller(true).UpdateAnnouncements(f.Service, configuration));
        Assert.Equal(0, await f.Db.ProductAnnouncementSyncs.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task MissingStatutoryCalendarPausesScheduleAndBacksOffEvenWhenSlotIsOverdue()
    {
        await using var f = new Fixture();
        var now = DateTime.UtcNow;
        await f.Db.ProductAnnouncementSyncs.InsertOneAsync(new ProductAnnouncementSync { CreatedAt = now.AddMonths(-1), NextRunAt = now.AddMinutes(-1) });
        await f.Service.TickAsync(now, default);
        Assert.NotNull((await f.Service.StatusAsync()).CalendarError);
        Assert.Single(f.Requests);
        await f.Service.TickAsync(now.AddSeconds(3), default);
        Assert.Single(f.Requests);
        Assert.Equal("idle", (await f.Service.StatusAsync()).Status);
    }

    [Fact]
    public async Task FailedDetailsDoNotBlockOtherItemsAndOnlyFailuresRetryWithDurableAudit()
    {
        await using var f = new Fixture();
        f.Pages[1] = Page("good", "互动营销V1.0.0") + Page("bad", "互动营销V1.0.1") + Page("network", "互动营销V1.0.2");
        f.Details["bad"] = "<h1>站点维护，contact@example.com token=private-value</h1>";
        f.NetworkFailures.Add("network");
        await f.Run();
        var status = await f.Service.StatusAsync();
        Assert.Equal("succeeded", status.Status);
        Assert.Equal(1, status.DetailSucceeded);
        Assert.Equal(2, status.Failed);
        var records = await f.Service.RecordsAsync(failedOnly: true);
        Assert.Equal(2, records.Total);
        Assert.All(records.Items, x => { Assert.Equal("failed", x.Status); Assert.Equal("抓取失败", x.StatusLabel); Assert.NotNull(x.Error); });
        var logs = await f.Db.ApiRequestLogs.Find(x => x.SessionId == status.RunId && x.ErrorCode != null).ToListAsync();
        Assert.Equal(2, logs.Count);
        var parseLog = Assert.Single(logs.Where(x => x.ErrorCode == "parse_failed"));
        Assert.Contains("格式未识别", Assert.Single(records.Items.Where(x => x.Id == "bad")).Error!);
        Assert.Contains("连接失败", Assert.Single(records.Items.Where(x => x.Id == "network")).Error!);
        using (var audit = JsonDocument.Parse(parseLog.ResponseBody!))
        {
            Assert.True(audit.RootElement.GetProperty("responseReceived").GetBoolean());
            Assert.False(audit.RootElement.GetProperty("parseSucceeded").GetBoolean());
        }
        var networkLog = Assert.Single(logs.Where(x => x.ErrorCode == "network_failed"));
        using (var audit = JsonDocument.Parse(networkLog.ResponseBody!))
        {
            Assert.False(audit.RootElement.GetProperty("responseReceived").GetBoolean());
            Assert.False(audit.RootElement.GetProperty("parseSucceeded").GetBoolean());
            Assert.Equal(JsonValueKind.Null, audit.RootElement.GetProperty("httpStatus").ValueKind);
        }
        f.Details.Remove("bad"); f.NetworkFailures.Clear();
        await f.Run();
        Assert.Equal(new[] { "bad", "network" }, f.DetailRequests);
        Assert.Equal(3, (await f.Service.StatusAsync()).DetailSucceeded);
        Assert.Equal(0, (await f.Service.StatusAsync()).Failed);
        Assert.Equal(2, (await f.Db.ProductAnnouncements.Find(x => x.Id == "bad").SingleAsync()).Attempts);
        Assert.Equal(1, (await f.Db.ProductAnnouncements.Find(x => x.Id == "good").SingleAsync()).Attempts);
        Assert.Equal(2, await f.Db.ApiRequestLogs.CountDocumentsAsync(x => x.SessionId == status.RunId && x.ErrorCode != null));
    }

    [Fact]
    public async Task IncrementalMixedPageProcessesAllNewItemsBeforeStoppingAtWholeSuccessfulFrontier()
    {
        await using var f = new Fixture();
        f.Pages[1] = Page("old", "互动营销V1.0.0", 2);
        f.Pages[2] = Page("older", "互动营销V0.9.0");
        await f.Run();
        // 旧公告排在新公告前，不能遇到第一条旧链接就停。
        f.Pages[1] = Page("old", "互动营销V1.0.0", 2) + Page("new", "互动营销V1.0.1");
        f.Pages[2] = Page("older", "互动营销V0.9.0", 3);
        await f.Run();
        Assert.Equal(new[] { 1, 2 }, f.Requests);
        Assert.Equal(new[] { "new" }, f.DetailRequests);
        Assert.Equal(3, (await f.Service.StatusAsync()).Total);
        Assert.True((await f.Service.StatusAsync()).ListingComplete);
        Assert.Equal("incremental", (await f.Db.ProductAnnouncementSyncs.Find(_ => true).SingleAsync()).ScanMode);
    }

    [Fact]
    public async Task RestartWithCompletedListResumesPendingDetailsWithoutRepeatingSuccessfulOnes()
    {
        await using var f = new Fixture();
        await f.Db.ProductAnnouncements.InsertManyAsync(new[] {
            new ProductAnnouncement { Id = "done", Url = "https://helper.weixin12315.com/945f/done", Title = "互动营销V1.0.0", DetailStatus = "succeeded", Attempts = 1 },
            new ProductAnnouncement { Id = "todo", Url = "https://helper.weixin12315.com/945f/todo", Title = "互动营销V1.0.1", DetailStatus = "running", Attempts = 1 },
        });
        await f.Db.ProductAnnouncementSyncs.InsertOneAsync(new ProductAnnouncementSync { Status = "running", RunId = "restarted",
            ListingComplete = true, NextPage = 9, LeaseOwner = "stopped-worker", LeaseUntil = DateTime.UtcNow.AddMinutes(-1) });
        f.Details["todo"] = Detail("互动营销V1.0.1");
        await f.NewService().TickAsync(DateTime.UtcNow, default);
        Assert.Empty(f.Requests);
        Assert.Equal(new[] { "todo" }, f.DetailRequests);
        Assert.Equal(2, (await f.Service.StatusAsync()).DetailSucceeded);
        Assert.Equal(1, (await f.Db.ProductAnnouncements.Find(x => x.Id == "done").SingleAsync()).Attempts);
        Assert.Equal(2, (await f.Db.ProductAnnouncements.Find(x => x.Id == "todo").SingleAsync()).Attempts);
    }

    [Fact]
    public async Task ActualDcrmVersionWithTwoAnnouncementPhasesRemainsAmbiguous()
    {
        await using var f = new Fixture();
        f.Pages[1] = Page("1f09", "DCRMV1.3.0（一期）-上线公告") + Page("37d6", "DCRMV1.3.0（二期）-上线公告");
        await f.Db.Products.InsertOneAsync(new Product { Id = "dcrm", Name = "DCRM" });
        await f.Db.ProductReleases.InsertOneAsync(new ProductRelease { Id = "formal", ProductId = "dcrm", AppName = "DCRM", VCode = "V1.3.0", Status = "released" });
        await f.Run();
        Assert.Null((await f.Db.ProductReleases.Find(x => x.Id == "formal").SingleAsync()).AnnouncementUrl);
        var records = await f.Service.RecordsAsync();
        Assert.Equal(2, records.Total);
        Assert.All(records.Items, x => { Assert.Equal("conflict", x.MatchStatus); Assert.Equal("匹配冲突", x.MatchStatusLabel); Assert.Equal(0, x.MatchedCount); });
        Assert.Equal(1, (await f.Service.StatusAsync()).Conflicts);
    }

    [Fact]
    public async Task CompleteSeedIsIdempotentAndMatchesFormalRecordsWithoutFetchingAgain()
    {
        await using var f = new Fixture();
        var item = new ProductAnnouncement { Url = "https://helper.weixin12315.com/945f/seed", Title = "品牌后台基础V4.26.2（名称变化）",
            PublishedAtRaw = "2024年4月2日", FooterTimeRaw = "2024-08-07", DetailStatus = "succeeded", Attempts = 1 };
        var seed = new ProductAnnouncementSeed { SchemaVersion = 1, SourceUrl = ProductAnnouncementSource.ListUrl,
            FetchedAt = DateTime.UtcNow, ScanCompleted = true, ExpectedPages = 1, PagesScanned = 1, Records = new() { item } };
        var released = DateTime.UtcNow.AddMonths(-1);
        await f.Db.Products.InsertOneAsync(new Product { Id = "p", Name = "品牌商后台基础" });
        await f.Db.ProductReleases.InsertOneAsync(new ProductRelease { Id = "v", ProductId = "p", AppName = "品牌商后台基础", VCode = "V4.26.2",
            TCode = "T4.26.1", PlanName = "旧方案名", Status = "released", ReleasedAt = released });
        await f.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration { Id = "t", Kind = VersionRegistrationKind.Internal,
            ApplicationName = "品牌商后台基础", Code = "T4.26.2" });
        Assert.Equal(1, await f.Service.ImportSeedAsync(seed, "seed-one"));
        Assert.Equal(0, await f.Service.ImportSeedAsync(seed, "seed-one"));
        await f.Service.TickAsync(DateTime.UtcNow, default);
        Assert.Empty(f.Requests); Assert.Empty(f.DetailRequests);
        var record = await f.Db.ProductReleases.Find(x => x.Id == "v").SingleAsync();
        Assert.Equal(item.Url, record.AnnouncementUrl);
        Assert.Equal("released", record.Status);
        Assert.Equal("T4.26.1", record.TCode);
        Assert.Equal(released.ToString("s"), record.ReleasedAt!.Value.ToString("s"));
        Assert.Null((await f.Db.VersionRegistrations.Find(x => x.Id == "t").SingleAsync()).AnnouncementUrl);
        Assert.Equal(1, (await f.Service.StatusAsync()).Matched);
        item.DetailStatus = "failed"; item.PublishedAtRaw = ""; item.FooterTimeRaw = "";
        Assert.Equal(0, await f.Service.ImportSeedAsync(seed, "seed-less-complete"));
        var kept = await f.Db.ProductAnnouncements.Find(x => x.Id == "seed").SingleAsync();
        Assert.Equal("succeeded", kept.DetailStatus); Assert.Equal("2024年4月2日", kept.PublishedAtRaw);
        Assert.Equal("2024-08-07", kept.FooterTimeRaw);
        Assert.Equal(1, await f.Db.ProductAnnouncements.CountDocumentsAsync(FilterDefinition<ProductAnnouncement>.Empty));
    }

    [Fact]
    public async Task PartialSeedKeepsIncompleteWatermarkAndInvalidSourceWritesNothing()
    {
        await using var f = new Fixture();
        var seed = new ProductAnnouncementSeed { SchemaVersion = 1, SourceUrl = ProductAnnouncementSource.ListUrl,
            ScanCompleted = false, ExpectedPages = 2, PagesScanned = 1, Records = new() {
                new ProductAnnouncement { Url = "https://helper.weixin12315.com/945f/partial", Title = "互动营销V1.0.0", DetailStatus = "succeeded" },
                new ProductAnnouncement { Url = "https://evil.example/945f/secret", Title = "错误来源", DetailStatus = "pending" },
            } };
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Service.ImportSeedAsync(seed, "invalid"));
        Assert.Equal(0, await f.Db.ProductAnnouncements.CountDocumentsAsync(FilterDefinition<ProductAnnouncement>.Empty));
        seed.Records.RemoveAt(1);
        await f.Service.ImportSeedAsync(seed, "partial");
        var status = await f.Service.StatusAsync();
        Assert.False(status.ListingComplete); Assert.Equal(1, status.NextPage); Assert.Null(status.LastSuccessAt);
        Assert.Equal(0, await f.Db.ProductAnnouncements.CountDocumentsAsync(x => x.Committed));
    }

    private sealed class Fixture : HttpMessageHandler, IHttpClientFactory, IAsyncDisposable
    {
        private readonly string name = "announcement_test_" + Guid.NewGuid().ToString("N");
        private readonly MongoClient client;
        public MongoDbContext Db { get; }
        public Dictionary<int, string> Pages { get; } = new();
        public List<int> Requests { get; } = new();
        public Dictionary<string, string> Details { get; } = new();
        public List<string> DetailRequests { get; } = new();
        public HashSet<string> NetworkFailures { get; } = new();
        public ProductAnnouncementSyncService Service { get; }
        public Fixture()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
            client = new MongoClient(connection); Db = new MongoDbContext(connection, name); Service = NewService();
        }
        public ProductAnnouncementSyncService NewService() => new(Db, this, NullLogger<ProductAnnouncementSyncService>.Instance);
        public HttpClient CreateClient(string _) => new(this, false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var uri = request.RequestUri!;
            if (uri.Host != "helper.weixin12315.com") { Requests.Add(1); return Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)); }
            if (uri.AbsolutePath == "/945f")
            {
                var page = string.IsNullOrEmpty(uri.Query) ? 1 : int.Parse(uri.Query.Split('=')[1]);
                Requests.Add(page);
                return Task.FromResult(Pages.TryGetValue(page, out var html)
                    ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(html) }
                    : new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
            }
            var id = uri.Segments[^1]; DetailRequests.Add(id);
            if (NetworkFailures.Contains(id)) throw new HttpRequestException("simulated public-source connection failure");
            if (Details.TryGetValue(id, out var detail)) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(detail) });
            var title = Pages.Values.SelectMany(html => ProductAnnouncementSource.ParsePage(html, 1).Items).FirstOrDefault(x => x.Id == id)?.Title ?? id;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Detail(title)) });
        }
        public async Task Run()
        {
            Requests.Clear(); DetailRequests.Clear();
            await Db.ProductAnnouncementSyncs.UpdateOneAsync(_ => true, Builders<ProductAnnouncementSync>.Update.Set(x => x.FinishedAt, DateTime.UtcNow.AddMinutes(-2)));
            await Service.RequestAsync("me", DateTime.UtcNow);
            await Service.TickAsync(DateTime.UtcNow, default);
        }
        public ValueTask DisposeAsync() => new(client.DropDatabaseAsync(name));
    }
}
