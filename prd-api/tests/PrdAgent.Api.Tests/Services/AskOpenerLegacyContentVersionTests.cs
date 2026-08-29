using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 存量站点（文档里没有 ContentVersion 这个字段）也必须能被认领与盖戳。
///
/// 为什么必须打真 Mongo：这条判据错在「C# 里成立的写法翻成 Mongo 谓词之后不成立」，
/// 而不是逻辑写错。`ContentVersion == default` 在内存里认得下缺字段的老文档（反序列化
/// 后就是 default），在 Mongo 里却只匹配显式存了零值的文档——只有让真的数据库来判，
/// 才能证明这件事。用假 IMongoCollection 或只读源码都测不出来。
/// </summary>
public sealed class AskOpenerLegacyContentVersionTests
{
    [Fact]
    public async Task 缺_ContentVersion_字段的老站点必须被认出来()
    {
        await using var fixture = await LegacyMongoFixture.CreateAsync();
        var raw = fixture.Db.HostedSites.Database.GetCollection<BsonDocument>("hosted_sites");

        // 老文档：一个字段都不多，尤其**没有** ContentVersion。
        // 这不是造出来的极端情况——WebPage.ContentVersion 的注释明确禁止给它加初始化器，
        // 就是为了让这一批文档保持这个形状。
        var createdAt = new DateTime(2026, 3, 4, 5, 6, 7, DateTimeKind.Utc);
        await raw.InsertOneAsync(new BsonDocument
        {
            { "_id", "legacy-site" },
            { "OwnerUserId", "u1" },
            { "Title", "存量站点" },
            { "CreatedAt", createdAt },
        });

        var matched = await fixture.Db.HostedSites
            .Find(AskOpeningQuestionGenerator.ContentVersionIs(createdAt))
            .ToListAsync();

        matched.Select(s => s.Id).ShouldBe(new[] { "legacy-site" });
    }

    [Fact]
    public async Task 老站点的版本对不上时不许匹配()
    {
        await using var fixture = await LegacyMongoFixture.CreateAsync();
        var raw = fixture.Db.HostedSites.Database.GetCollection<BsonDocument>("hosted_sites");
        var createdAt = new DateTime(2026, 3, 4, 5, 6, 7, DateTimeKind.Utc);
        await raw.InsertOneAsync(new BsonDocument
        {
            { "_id", "legacy-site" },
            { "CreatedAt", createdAt },
        });

        // 回退到 CreatedAt 不等于「不看版本」：重传过的那一发算的是旧正文，仍要被挡住
        var matched = await fixture.Db.HostedSites
            .Find(AskOpeningQuestionGenerator.ContentVersionIs(createdAt.AddSeconds(1)))
            .ToListAsync();

        matched.ShouldBeEmpty();
    }

    [Fact]
    public async Task 有_ContentVersion_的站点按它自己那一版判()
    {
        await using var fixture = await LegacyMongoFixture.CreateAsync();
        var createdAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var contentVersion = new DateTime(2026, 6, 6, 6, 6, 6, DateTimeKind.Utc);
        await fixture.Db.HostedSites.InsertOneAsync(new HostedSite
        {
            Id = "fresh-site",
            OwnerUserId = "u1",
            CreatedAt = createdAt,
            ContentVersion = contentVersion,
        });

        (await fixture.Db.HostedSites.Find(
            AskOpeningQuestionGenerator.ContentVersionIs(contentVersion)).ToListAsync())
            .Select(s => s.Id).ShouldBe(new[] { "fresh-site" });

        // 重传过的站点不能再按 CreatedAt 认——那是它的第一版，不是当前这一版
        (await fixture.Db.HostedSites.Find(
            AskOpeningQuestionGenerator.ContentVersionIs(createdAt)).ToListAsync())
            .ShouldBeEmpty();
    }

    private sealed class LegacyMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private LegacyMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<LegacyMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            // 连不上就当场炸，不静默跳过——一条不会红的证据比没有证据更糟
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new LegacyMongoFixture(client, connectionString, $"ask_legacy_test_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
