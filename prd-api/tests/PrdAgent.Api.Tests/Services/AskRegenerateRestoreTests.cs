using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 「重新生成」这一发失败之后，把 owner 的手写标记还回去——但不许还错人。
///
/// 这条路径的时间窗有 45 秒：期间清掉了 source 与版本戳两笔，只要有一个条件没盖住，
/// 另一个 editor 在这窗口里保存的手写题就会被这一笔悄悄改回 auto，从此失去
/// 「手写过的永不被自动覆盖」的保护——而他收到的回复是「保存成功」。
///
/// 判据直接从 <see cref="WebPageAskController.RestoreAskSourceFilter"/> 取，不在这里抄一份，
/// 否则改坏了生产代码这里照样绿。打的是真库，验的是「这一笔到底落不落下去」。
/// </summary>
public sealed class AskRegenerateRestoreTests
{
    [Fact]
    public async Task 生成失败期间没人动过_还原照常落下去()
    {
        await using var fixture = await RestoreMongoFixture.CreateAsync();
        // 重新生成清掉两笔之后的样子
        var id = await SeedAsync(fixture, source: AskOpeningQuestions.SourceAuto, stamp: null);

        var matched = await ApplyRestoreAsync(fixture, id, restoreTo: AskOpeningQuestions.SourceManual);

        matched.ShouldBe(1);
        var stored = await fixture.Db.HostedSites.Find(s => s.Id == id).SingleAsync();
        stored.AskQuestionsSource.ShouldBe(AskOpeningQuestions.SourceManual);
    }

    [Fact]
    public async Task 期间另一个editor保存了手写题_这一笔必须停手()
    {
        await using var fixture = await RestoreMongoFixture.CreateAsync();
        // SetAskConfigAsync 把 source 写成 manual，但**不动版本戳**——
        // 所以「戳仍为空」在这一刻依然成立，只靠它判就会误伤。
        var id = await SeedAsync(fixture, source: AskOpeningQuestions.SourceManual, stamp: null);

        var matched = await ApplyRestoreAsync(fixture, id, restoreTo: AskOpeningQuestions.SourceAuto);

        matched.ShouldBe(0);
        var stored = await fixture.Db.HostedSites.Find(s => s.Id == id).SingleAsync();
        stored.AskQuestionsSource.ShouldBe(AskOpeningQuestions.SourceManual);
    }

    [Fact]
    public async Task 期间另一发已经写好并盖了戳_这一笔同样停手()
    {
        await using var fixture = await RestoreMongoFixture.CreateAsync();
        var id = await SeedAsync(
            fixture, source: AskOpeningQuestions.SourceAuto, stamp: DateTime.UtcNow);

        var matched = await ApplyRestoreAsync(fixture, id, restoreTo: AskOpeningQuestions.SourceManual);

        matched.ShouldBe(0);
        var stored = await fixture.Db.HostedSites.Find(s => s.Id == id).SingleAsync();
        stored.AskQuestionsSource.ShouldBe(AskOpeningQuestions.SourceAuto);
        stored.AskQuestionsGeneratedFor.ShouldNotBeNull();
    }

    [Fact]
    public async Task 读与清之间没人动过_开头那笔清除照常落下去()
    {
        await using var fixture = await RestoreMongoFixture.CreateAsync();
        var stamp = DateTime.UtcNow;
        var id = await SeedAsync(fixture, source: AskOpeningQuestions.SourceManual, stamp: stamp);

        var stored = await fixture.Db.HostedSites.Find(s => s.Id == id).SingleAsync();
        var matched = await ApplyResetAsync(
            fixture, id, stored.AskQuestionsSource, stored.AskQuestionsGeneratedFor);

        matched.ShouldBe(1);
    }

    [Fact]
    public async Task 读与清之间另一个editor改了来源_开头那笔必须停手()
    {
        await using var fixture = await RestoreMongoFixture.CreateAsync();
        // 我读到的是 auto；别人在这个空隙里保存了手写题，库里已经是 manual
        var id = await SeedAsync(fixture, source: AskOpeningQuestions.SourceManual, stamp: null);

        var matched = await ApplyResetAsync(fixture, id, AskOpeningQuestions.SourceAuto, null);

        matched.ShouldBe(0);
        var stored = await fixture.Db.HostedSites.Find(s => s.Id == id).SingleAsync();
        // 他刚写下的 manual 必须原样还在，没被这一笔改回 auto
        stored.AskQuestionsSource.ShouldBe(AskOpeningQuestions.SourceManual);
    }

    [Fact]
    public async Task 存量站点没有来源字段_照常放行()
    {
        await using var fixture = await RestoreMongoFixture.CreateAsync();
        // 这个字段是本功能才加的，存量文档里压根没有；不能因此把老站点整类挡在门外
        var id = await SeedAsync(fixture, source: null, stamp: null);

        var matched = await ApplyResetAsync(fixture, id, null, null);

        matched.ShouldBe(1);
    }

    private static async Task<long> ApplyResetAsync(
        RestoreMongoFixture fixture, string siteId, string? expectedSource, DateTime? expectedStamp)
    {
        var result = await fixture.Db.HostedSites.UpdateOneAsync(
            WebPageAskController.ResetAskSourceFilter(siteId, expectedSource, expectedStamp),
            Builders<HostedSite>.Update.Set(s => s.AskQuestionsSource, AskOpeningQuestions.SourceAuto));
        return result.MatchedCount;
    }

    private static async Task<long> ApplyRestoreAsync(
        RestoreMongoFixture fixture, string siteId, string restoreTo)
    {
        var result = await fixture.Db.HostedSites.UpdateOneAsync(
            WebPageAskController.RestoreAskSourceFilter(siteId),
            Builders<HostedSite>.Update.Set(s => s.AskQuestionsSource, restoreTo));
        return result.MatchedCount;
    }

    private static async Task<string> SeedAsync(
        RestoreMongoFixture fixture, string source, DateTime? stamp)
    {
        var site = new HostedSite
        {
            OwnerUserId = "u1",
            Title = "站点",
            AskEnabled = true,
            AskQuestionsSource = source,
            AskQuestionsGeneratedFor = stamp,
            AskSuggestedQuestions = new List<string> { "第一题" },
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);
        return site.Id;
    }

    private sealed class RestoreMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private RestoreMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<RestoreMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new RestoreMongoFixture(
                client, connectionString, $"ask_restore_test_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
