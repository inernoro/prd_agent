using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 站点删除围栏打在真 MongoDB 上：租约条件里 null 与「字段整个不存在」的判定差别，
/// 只有真库能证明，纯结构断言证不了。
/// </summary>
[Trait("Category", TestCategories.Integration)]
public sealed class HostedSiteDeletionFenceMongoTests
{
    private const string SiteId = "fedcba98765432100123456789abcdef";
    private const string UserId = "hosted-site-fence-user";

    private static readonly DateTime ContentVersion = new(2026, 9, 16, 0, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime UpdatedAt = new(2026, 9, 16, 1, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime Now = new(2026, 9, 16, 2, 0, 0, DateTimeKind.Utc);

    private static async Task<long> TryDeleteAsync(MongoDbContext db) =>
        (await db.HostedSites.DeleteOneAsync(
            HostedSiteService.BuildHostedSiteDeletionFence(SiteId, UserId, ContentVersion, UpdatedAt, Now),
            CancellationToken.None)).DeletedCount;

    [Fact]
    public async Task ActiveBorrowLease_ShouldBlockDeletionEvenThoughContentSnapshotStillMatches()
    {
        await using var fixture = await FenceMongoFixture.CreateAsync();
        // 借用登记只写租约与两个键数组，刻意不碰 ContentVersion / UpdatedAt——
        // 这正是原来那道围栏漏掉这个交错窗口的原因。
        await SeedAsync(fixture.Db, lease: Now.AddMinutes(5), inProgress: new List<string> { "k1" });

        Assert.Equal(0, await TryDeleteAsync(fixture.Db));
        Assert.True(await fixture.Db.HostedSites.Find(x => x.Id == SiteId).AnyAsync());
    }

    [Fact]
    public async Task ExpiredLease_ShouldDeleteSoAStuckPublisherCannotBlockDeletionForever()
    {
        await using var fixture = await FenceMongoFixture.CreateAsync();
        await SeedAsync(fixture.Db, lease: Now.AddMinutes(-1), inProgress: new List<string> { "k1" });

        Assert.Equal(1, await TryDeleteAsync(fixture.Db));
    }

    [Fact]
    public async Task ReleasedKeysButLeaseTimestampStillInFuture_ShouldDelete()
    {
        await using var fixture = await FenceMongoFixture.CreateAsync();
        // 释放登记只 PullAll 键数组、不回拨租约时间戳，所以「键空了」必须单独算作不在进行中，
        // 否则每次发布之后都要白等满 5 分钟租约才删得掉。
        await SeedAsync(fixture.Db, lease: Now.AddMinutes(5), inProgress: new List<string>());

        Assert.Equal(1, await TryDeleteAsync(fixture.Db));
    }

    [Fact]
    public async Task NeverReservedSite_ShouldDelete()
    {
        await using var fixture = await FenceMongoFixture.CreateAsync();
        await SeedAsync(fixture.Db, lease: null, inProgress: new List<string>());

        Assert.Equal(1, await TryDeleteAsync(fixture.Db));
    }

    [Fact]
    public async Task LegacyDocumentWithoutTheLeaseFieldsAtAll_ShouldStillDelete()
    {
        await using var fixture = await FenceMongoFixture.CreateAsync();
        // 存量文档没有这两个字段。Mongo 里「缺失」与「null」不是一回事，
        // 围栏漏掉 $exists:false 那一支的话，本 PR 之前建的站点会永远删不掉。
        await fixture.Db.HostedSites.Database
            .GetCollection<BsonDocument>(fixture.Db.HostedSites.CollectionNamespace.CollectionName)
            .InsertOneAsync(new BsonDocument
            {
                { "_id", SiteId },
                { "OwnerUserId", UserId },
                { "ContentVersion", ContentVersion },
                { "UpdatedAt", UpdatedAt },
            });

        Assert.Equal(1, await TryDeleteAsync(fixture.Db));
    }

    [Fact]
    public async Task ContentRewrittenDuringDeletion_ShouldStillBlock()
    {
        await using var fixture = await FenceMongoFixture.CreateAsync();
        await SeedAsync(fixture.Db, lease: null, inProgress: new List<string>(), updatedAt: UpdatedAt.AddSeconds(1));

        Assert.Equal(0, await TryDeleteAsync(fixture.Db));
    }

    private static Task SeedAsync(
        MongoDbContext db,
        DateTime? lease,
        List<string> inProgress,
        DateTime? updatedAt = null) =>
        db.HostedSites.InsertOneAsync(new HostedSite
        {
            Id = SiteId,
            OwnerUserId = UserId,
            Title = "围栏站点",
            ContentVersion = ContentVersion,
            UpdatedAt = updatedAt ?? UpdatedAt,
            AssetPublishLeaseExpiresAt = lease,
            AssetPublishInProgressKeys = inProgress,
        });

    private sealed class FenceMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private FenceMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<FenceMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new FenceMongoFixture(client, connectionString, $"hosted_site_fence_test_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
