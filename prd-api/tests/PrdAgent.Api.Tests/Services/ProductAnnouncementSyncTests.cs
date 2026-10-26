using System.Net;
using System.Security.Claims;
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
    public void StatutoryHolidaysAndMakeupSundayDetermineFirstWorkdayAtBeijingEight()
    {
        var calendar = ProductAnnouncementSource.ParseCalendar($$"""{"year":2026,"papers":["{{Official}}"],"days":[{"date":"2026-01-01","isOffDay":true},{"date":"2026-01-02","isOffDay":true},{"date":"2026-01-03","isOffDay":true},{"date":"2026-01-04","isOffDay":false},{"date":"2026-05-01","isOffDay":true},{"date":"2026-05-04","isOffDay":true},{"date":"2026-05-05","isOffDay":true}]}""", 2026);
        Assert.Equal(new DateTime(2026, 1, 4, 0, 0, 0, DateTimeKind.Utc), ProductAnnouncementSource.MonthlySlotUtc(2026, 1, calendar));
        Assert.Equal(new DateTime(2026, 5, 6, 0, 0, 0, DateTimeKind.Utc), ProductAnnouncementSource.MonthlySlotUtc(2026, 5, calendar));
        Assert.Throws<InvalidDataException>(() => ProductAnnouncementSource.ParseCalendar("{\"year\":2026,\"papers\":[],\"days\":[]}", 2026));
    }

    [Fact]
    public async Task FullPaginationThenIncrementalStopAndRematchLaterImportsWithoutChangingIssuance()
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
        Assert.Null((await f.Db.ProductReleases.Find(x => x.Id == "other").SingleAsync()).AnnouncementUrl);
        await f.Db.VersionRegistrations.InsertOneAsync(new VersionRegistration { Id = "later", Kind = "formal", ApplicationName = "品牌商后台基础", Code = "V4.26.2" });
        await f.Run();
        Assert.Equal(new[] { 1 }, f.Requests);
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
        f.Pages[2] = Page("ambiguous", "互动营销V1.0.0（另一个公告）");
        await f.Db.Products.InsertOneAsync(new Product { Id = "a", Name = "互动营销" });
        await f.Db.ProductReleases.InsertOneAsync(new ProductRelease { Id = "v", ProductId = "a", VCode = "V1.0.0", AnnouncementUrl = "https://original.example/notice" });
        await f.Run();
        Assert.Equal(new[] { 1, 2 }, f.Requests);
        Assert.Equal(2, await f.Db.ProductAnnouncements.CountDocumentsAsync(x => x.Committed));
        Assert.Equal(1, (await f.Service.StatusAsync()).Conflicts);
        Assert.Equal("https://original.example/notice", (await f.Db.ProductReleases.Find(x => x.Id == "v").SingleAsync()).AnnouncementUrl);
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
        Assert.IsType<ConflictObjectResult>(await Controller(true).UpdateAnnouncements(f.Service, configuration));
        Assert.Equal(0, await f.Db.ProductAnnouncementSyncs.CountDocumentsAsync(_ => true));
    }

    private sealed class Fixture : HttpMessageHandler, IHttpClientFactory, IAsyncDisposable
    {
        private readonly string name = "announcement_test_" + Guid.NewGuid().ToString("N");
        private readonly MongoClient client;
        public MongoDbContext Db { get; }
        public Dictionary<int, string> Pages { get; } = new();
        public List<int> Requests { get; } = new();
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
            var page = string.IsNullOrEmpty(request.RequestUri!.Query) ? 1 : int.Parse(request.RequestUri.Query.Split('=')[1]);
            Requests.Add(page);
            return Task.FromResult(Pages.TryGetValue(page, out var html)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(html) }
                : new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
        }
        public async Task Run()
        {
            Requests.Clear();
            await Db.ProductAnnouncementSyncs.UpdateOneAsync(_ => true, Builders<ProductAnnouncementSync>.Update.Set(x => x.FinishedAt, DateTime.UtcNow.AddMinutes(-2)));
            await Service.RequestAsync("me", DateTime.UtcNow);
            await Service.TickAsync(DateTime.UtcNow, default);
        }
        public ValueTask DisposeAsync() => new(client.DropDatabaseAsync(name));
    }
}
