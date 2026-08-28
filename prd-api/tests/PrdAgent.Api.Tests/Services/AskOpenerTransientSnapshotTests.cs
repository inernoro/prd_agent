using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 「这页确实没有正文」和「这次没读回来」是两件事，盖不盖版本戳完全相反。
///
/// 快照服务已经把这个区别算出来了（TransientFailure），而且对暂时性失败**拒绝缓存**。
/// 生成器如果对所有 Unavailable 一律盖戳，就把那半边保护当场抵消掉：存储恢复之后再也
/// 没人会排一次生成，这个站点要等到正文变了或者 owner 手动点重新生成才有开场问题。
/// 这类退化不会有任何报错，所以必须有守卫。
/// </summary>
public sealed class AskOpenerTransientSnapshotTests
{
    [Fact]
    public async Task 暂时读不到正文_不盖版本戳_留给下次重试()
    {
        await using var fixture = await AskOpenerMongoFixture.CreateAsync();
        var site = await SeedAsync(fixture);
        var generator = Build(fixture, new StubSnapshots(transient: true));

        var outcome = await generator.EnsureAsync(site.Id);

        outcome.ShouldNotBe(AskOpenerOutcome.NoContent);
        var stored = await fixture.Db.HostedSites.Find(s => s.Id == site.Id).SingleAsync();
        // 没盖戳 = NeedsGeneration 下次还会判 true，存储恢复后自己会补上
        stored.AskQuestionsGeneratedFor.ShouldBeNull();
        AskOpeningQuestionGenerator.NeedsGeneration(stored).ShouldBeTrue();
    }

    [Fact]
    public async Task 确定没有正文_照常盖版本戳_不让每个访客都再排一次()
    {
        await using var fixture = await AskOpenerMongoFixture.CreateAsync();
        var site = await SeedAsync(fixture);
        var generator = Build(fixture, new StubSnapshots(transient: false));

        var outcome = await generator.EnsureAsync(site.Id);

        outcome.ShouldBe(AskOpenerOutcome.NoContent);
        var stored = await fixture.Db.HostedSites.Find(s => s.Id == site.Id).SingleAsync();
        stored.AskQuestionsGeneratedFor.ShouldNotBeNull();
        AskOpeningQuestionGenerator.NeedsGeneration(stored).ShouldBeFalse();
    }

    private static async Task<HostedSite> SeedAsync(AskOpenerMongoFixture fixture)
    {
        var site = new HostedSite
        {
            OwnerUserId = "user-ask-opener",
            Title = "一份站点",
            AskEnabled = true,
            ContentVersion = DateTime.UtcNow,
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);
        return site;
    }

    private static AskOpeningQuestionGenerator Build(
        AskOpenerMongoFixture fixture, ISiteContentSnapshotService snapshots)
    {
        var services = new ServiceCollection();
        services.AddSingleton(fixture.Db);
        services.AddSingleton(snapshots);
        var provider = services.BuildServiceProvider();
        return new AskOpeningQuestionGenerator(
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<AskOpeningQuestionGenerator>.Instance);
    }

    /// <summary>
    /// 只回答「读到了没有 / 是不是暂时的」这一个问题；正文一律为空，所以两条用例都走不到
    /// 模型调用那一步——这正是本条要测的分支。
    /// </summary>
    private sealed class StubSnapshots : ISiteContentSnapshotService
    {
        private readonly bool _transient;

        internal StubSnapshots(bool transient) => _transient = transient;

        public Task<SiteContentSnapshot> GetAsync(HostedSite site, CancellationToken ct = default)
            => Task.FromResult(new SiteContentSnapshot
            {
                SiteId = site.Id,
                Text = string.Empty,
                TransientFailure = _transient,
                Unavailable = _transient
                    ? "暂时读取不到这个页面的内容，请稍后再试。"
                    : "这个页面没有可供阅读的文字内容。",
            });
    }

    private sealed class AskOpenerMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private AskOpenerMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<AskOpenerMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new AskOpenerMongoFixture(
                client, connectionString, $"ask_opener_test_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
