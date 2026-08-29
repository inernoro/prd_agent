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
/// 撤销分享的审计只有第一笔算数。
///
/// RevokedAt / RevokedReason 在分享管理面板上是**撤销这件事的历史记录**（「8 月 11 日撤销 ·
/// 客户已验收」）。而 DELETE 会被重发——网关超时后客户端重试、两个标签页同时点撤销都算。
/// 重发若照样写一遍，撤销时刻会被改成「现在」，不带理由的那次还会把第一次写下的理由抹掉：
/// 界面上那行历史就成了假的，而且没有任何东西会报错。
/// </summary>
public sealed class ShareRevokeAuditTests
{
    [Fact]
    public async Task 重复撤销不改写第一笔审计_但仍然返回成功()
    {
        await using var fixture = await ShareRevokeMongoFixture.CreateAsync();
        var service = Build(fixture);
        var share = await SeedAsync(fixture);

        (await service.RevokeShareAsync(share.Id, share.CreatedBy, "客户已验收", CancellationToken.None))
            .ShouldBeTrue();
        var first = await fixture.Db.WebPageShareLinks.Find(x => x.Id == share.Id).SingleAsync();
        first.IsRevoked.ShouldBeTrue();
        first.RevokedReason.ShouldBe("客户已验收");
        first.RevokedAt.ShouldNotBeNull();

        // 重发的那一次：不带理由（客户端重试时常常如此）
        await Task.Delay(20);
        (await service.RevokeShareAsync(share.Id, share.CreatedBy, null, CancellationToken.None))
            .ShouldBeTrue("重试要的结果已经达成，回 false 会让界面显示撤销失败");

        var after = await fixture.Db.WebPageShareLinks.Find(x => x.Id == share.Id).SingleAsync();
        after.RevokedReason.ShouldBe("客户已验收", "第二次调用把第一次写下的理由抹掉了");
        after.RevokedAt.ShouldBe(first.RevokedAt, "撤销时刻被改成了重试那一刻");
    }

    [Fact]
    public async Task 不是自己的或不存在的分享仍然回_false()
    {
        await using var fixture = await ShareRevokeMongoFixture.CreateAsync();
        var service = Build(fixture);
        var share = await SeedAsync(fixture);

        // 「已经撤销过」要回 true，「根本轮不到你撤」必须回 false——端点靠它转 404，
        // 两者混成一个返回值就等于把越权当成幂等放过去了
        (await service.RevokeShareAsync(share.Id, "另一个人", null, CancellationToken.None)).ShouldBeFalse();
        (await service.RevokeShareAsync("不存在的分享", share.CreatedBy, null, CancellationToken.None)).ShouldBeFalse();
    }

    private static async Task<WebPageShareLink> SeedAsync(ShareRevokeMongoFixture fixture)
    {
        var share = new WebPageShareLink
        {
            Token = "tok-" + Guid.NewGuid().ToString("N")[..8],
            CreatedBy = "owner-1",
            SiteId = "site-1",
            AccessLevel = "public",
        };
        await fixture.Db.WebPageShareLinks.InsertOneAsync(share);
        return share;
    }

    private static HostedSiteService Build(ShareRevokeMongoFixture fixture)
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

    private sealed class ShareRevokeMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private ShareRevokeMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<ShareRevokeMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new ShareRevokeMongoFixture(client, connectionString, $"share_revoke_test_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
