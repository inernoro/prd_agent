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
/// 保存提问配置时，题库这一栏什么时候该写、什么时候一个字都不许动。
///
/// 为什么单独立一条：打开设置抽屉会顺手排一次后台生成，而抽屉里那份题是**打开那一刻**
/// 读到的旧值（多半是空）。owner 只改了个无关开关就保存，如果无条件回写，他手上那份旧值
/// 会盖掉这期间生成好的题；更糟的是「提交的与库里的不一样」会被判成「他动过手」，从此把
/// 站点钉成 manual，自动生成再也补不回来——两个后果都不会有任何测试自己变红。
/// </summary>
public sealed class AskConfigQuestionWriteTests
{
    [Fact]
    public async Task 题库传_null_时_题库与来源标记都不许动()
    {
        await using var fixture = await AskConfigMongoFixture.CreateAsync();
        var site = await SeedAsync(fixture, questions: new List<string> { "系统写的第一题" }, source: "auto");
        var service = Build(fixture);

        var updated = await service.SetAskConfigAsync(site.Id, site.OwnerUserId, new AskConfigUpdate
        {
            Enabled = true,
            Welcome = "改的是欢迎语，不是题库",
            SuggestedQuestions = null,
            AllowAnonymous = true,
            DailyLimit = 5,
        });

        updated.ShouldNotBeNull();
        var stored = await fixture.Db.HostedSites.Find(s => s.Id == site.Id).SingleAsync();
        stored.AskSuggestedQuestions.ShouldBe(new[] { "系统写的第一题" });
        stored.AskQuestionsSource.ShouldBe("auto");
        // 其它字段照常写进去——「不动题库」不等于「整笔不写」
        stored.AskWelcome.ShouldBe("改的是欢迎语，不是题库");
        stored.AskDailyLimit.ShouldBe(5);
        // 返回的那份也要与库里一致，否则抽屉关掉再打开会看到两个不同的答案
        updated.AskSuggestedQuestions.ShouldBe(new[] { "系统写的第一题" });
        updated.AskQuestionsSource.ShouldBe("auto");
    }

    [Fact]
    public async Task 题库真的被改过时_照常写入并钉成手写()
    {
        await using var fixture = await AskConfigMongoFixture.CreateAsync();
        var site = await SeedAsync(fixture, questions: new List<string> { "系统写的第一题" }, source: "auto");
        var service = Build(fixture);

        await service.SetAskConfigAsync(site.Id, site.OwnerUserId, new AskConfigUpdate
        {
            Enabled = true,
            SuggestedQuestions = new List<string> { "我自己写的题" },
            AllowAnonymous = false,
            DailyLimit = 0,
        });

        var stored = await fixture.Db.HostedSites.Find(s => s.Id == site.Id).SingleAsync();
        stored.AskSuggestedQuestions.ShouldBe(new[] { "我自己写的题" });
        stored.AskQuestionsSource.ShouldBe("manual");
    }

    [Fact]
    public async Task 原样提交同一份题库_不算动过手()
    {
        // 只改别的开关、把面板上原样回显的那份又提交一遍，不该把站点钉成 manual——
        // 钉了的话自动生成第一次写完就永远不会再更新。
        await using var fixture = await AskConfigMongoFixture.CreateAsync();
        var site = await SeedAsync(fixture, questions: new List<string> { "系统写的第一题" }, source: "auto");
        var service = Build(fixture);

        await service.SetAskConfigAsync(site.Id, site.OwnerUserId, new AskConfigUpdate
        {
            Enabled = true,
            SuggestedQuestions = new List<string> { "系统写的第一题" },
            AllowAnonymous = false,
            DailyLimit = 0,
        });

        var stored = await fixture.Db.HostedSites.Find(s => s.Id == site.Id).SingleAsync();
        stored.AskQuestionsSource.ShouldBe("auto");
    }

    private static async Task<HostedSite> SeedAsync(
        AskConfigMongoFixture fixture, List<string> questions, string source)
    {
        var site = new HostedSite
        {
            OwnerUserId = "user-ask-config",
            Title = "一份站点",
            AskEnabled = true,
            AskSuggestedQuestions = questions,
            AskQuestionsSource = source,
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);
        return site;
    }

    private static HostedSiteService Build(AskConfigMongoFixture fixture)
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

    private sealed class AskConfigMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private AskConfigMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<AskConfigMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new AskConfigMongoFixture(
                client, connectionString, $"ask_config_test_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
