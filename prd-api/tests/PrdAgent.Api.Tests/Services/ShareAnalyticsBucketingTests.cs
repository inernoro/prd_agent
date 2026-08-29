using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 数据抽屉的日趋势与时段分布：一次聚合分桶，且两张图都覆盖**整个窗口**。
///
/// 改这段之前，趋势是每天一次 CountDocuments（端点收 365 天 = 365 次串行往返），
/// 时段分布则是拿封顶 5000 条的样本在内存里数——高流量账号看到的「几点最热」只反映
/// 最近那 5000 次访问，界面上却写着「近 N 天」。
///
/// 所以这里必须打真 Mongo：$dateToString / $hour 的时区口径、以及「超过样本上限之后
/// 时段图还准不准」，都只有真的跑一遍聚合才能证明。
/// </summary>
public sealed class ShareAnalyticsBucketingTests
{
    [Fact]
    public async Task 日趋势与时段分布按全窗口分桶_没访问的那天补零()
    {
        await using var fixture = await AnalyticsMongoFixture.CreateAsync();
        var service = Build(fixture);
        var today = DateTime.UtcNow.Date;

        await SeedShareAsync(fixture, "tok-a");
        // 今天 03 点两次、09 点一次；昨天 03 点一次；前天一次都没有
        await SeedViewsAsync(fixture, "tok-a", today.AddHours(3), 2);
        await SeedViewsAsync(fixture, "tok-a", today.AddHours(9), 1);
        await SeedViewsAsync(fixture, "tok-a", today.AddDays(-1).AddHours(3), 1);

        var result = await service.GetShareAnalyticsAsync("owner-1", 3);

        result.Trend.Count.ShouldBe(3);
        result.Trend[0].Date.ShouldBe(today.AddDays(-2).ToString("yyyy-MM-dd"));
        // 没人来的那天必须是 0 而不是被跳过——少一个点会让折线把两天连成一段，
        // 看上去像那天没统计，而不是没人来
        result.Trend[0].Views.ShouldBe(0);
        result.Trend[1].Views.ShouldBe(1);
        result.Trend[2].Views.ShouldBe(3);

        result.Hourly.Count.ShouldBe(24);
        result.Hourly.Single(h => h.Hour == 3).Views.ShouldBe(3, "两天的 03 点要合并计数");
        result.Hourly.Single(h => h.Hour == 9).Views.ShouldBe(1);
        result.Hourly.Where(h => h.Hour != 3 && h.Hour != 9).Sum(h => h.Views).ShouldBe(0);
    }

    [Fact]
    public async Task 窗口外的访问不算进来()
    {
        await using var fixture = await AnalyticsMongoFixture.CreateAsync();
        var service = Build(fixture);
        var today = DateTime.UtcNow.Date;

        await SeedShareAsync(fixture, "tok-a");
        await SeedViewsAsync(fixture, "tok-a", today.AddHours(5), 1);
        // 窗口只有 2 天（今天 + 昨天），这条落在前天
        await SeedViewsAsync(fixture, "tok-a", today.AddDays(-2).AddHours(5), 4);

        var result = await service.GetShareAnalyticsAsync("owner-1", 2);

        result.Trend.Sum(t => t.Views).ShouldBe(1);
        result.Hourly.Sum(h => h.Views).ShouldBe(1);
    }

    [Fact]
    public async Task 超过日志样本上限时时段分布仍要覆盖全窗口()
    {
        // 这条才是「时段分布不再靠样本」的真判据：上面两条数据量小，样本==全量，
        // 就算改回按样本内存计数它们照样绿（那种绿什么都证明不了）。
        // 这里把样本上限撑破——最老的那条一定落在样本之外，它所在的小时是否还被数进去，
        // 就是「全窗口聚合」与「近因偏置的样本」之间的分水岭。
        await using var fixture = await AnalyticsMongoFixture.CreateAsync();
        var service = Build(fixture);
        var today = DateTime.UtcNow.Date;

        await SeedShareAsync(fixture, "tok-a");
        // 5000 条压在 10 点（都比下面那条新），正好占满样本
        await SeedManyAsync(fixture, "tok-a", today.AddHours(10), 5000);
        // 1 条更早的落在 2 点：按 ViewedAt 倒序取 5000 条时，它一定被挤出样本
        await SeedViewsAsync(fixture, "tok-a", today.AddHours(2), 1);

        var result = await service.GetShareAnalyticsAsync("owner-1", 1);

        result.Hourly.Single(h => h.Hour == 2).Views.ShouldBe(1, "被挤出样本的那一小时不能凭空消失");
        result.Hourly.Single(h => h.Hour == 10).Views.ShouldBe(5000);
        result.Trend.Single().Views.ShouldBe(5001);
    }

    private static async Task SeedManyAsync(
        AnalyticsMongoFixture fixture, string token, DateTime baseAt, int count)
    {
        // 同一小时内铺开秒数，避免全部撞在同一时刻让倒序不稳定
        var logs = Enumerable.Range(0, count).Select(i => new ShareViewLog
        {
            ShareToken = token,
            ShareOwnerUserId = "owner-1",
            ViewedAt = baseAt.AddMilliseconds(i * 100),
            IpAddress = $"10.1.{i / 256 % 256}.{i % 256}",
        }).ToList();
        await fixture.Db.ShareViewLogs.InsertManyAsync(logs);
    }

    private static async Task SeedShareAsync(AnalyticsMongoFixture fixture, string token)
        => await fixture.Db.WebPageShareLinks.InsertOneAsync(new WebPageShareLink
        {
            Token = token,
            CreatedBy = "owner-1",
            SiteId = "site-1",
            AccessLevel = "public",
        });

    private static async Task SeedViewsAsync(
        AnalyticsMongoFixture fixture, string token, DateTime viewedAt, int count)
    {
        var logs = Enumerable.Range(0, count).Select(i => new ShareViewLog
        {
            ShareToken = token,
            ShareOwnerUserId = "owner-1",
            ViewedAt = viewedAt.AddMinutes(i),
            IpAddress = $"10.0.0.{i + 1}",
        }).ToList();
        await fixture.Db.ShareViewLogs.InsertManyAsync(logs);
    }

    private static HostedSiteService Build(AnalyticsMongoFixture fixture)
        => new(
            fixture.Db,
            Mock.Of<IAssetStorage>(),
            Mock.Of<IShortLinkService>(),
            Mock.Of<ISharePasswordService>(),
            Mock.Of<ITeamService>(),
            Mock.Of<ITeamActivityService>(),
            Mock.Of<IUploadProgressService>(),
            Mock.Of<IAskOpeningQuestionGenerator>(),
            NullLogger<HostedSiteService>.Instance);

    private sealed class AnalyticsMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private AnalyticsMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<AnalyticsMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new AnalyticsMongoFixture(client, connectionString, $"share_analytics_test_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
