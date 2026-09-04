using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class WebFolderRenameFenceTests
{
    [Fact]
    public async Task 并发重命名等待同一把锁_不把重复键暴露给调用方()
    {
        await using var fixture = await RenameFenceMongoFixture.CreateAsync();
        var folder = new WebFolder
        {
            Id = "folder-concurrent",
            OwnerUserId = "owner-concurrent",
            Name = "初始名称",
        };
        await fixture.Db.WebFolders.InsertOneAsync(folder);
        var service = new WebFolderService(
            fixture.Db,
            Mock.Of<IHostedSiteService>(),
            Mock.Of<IDocumentService>(),
            NullLogger<WebFolderService>.Instance);

        var updates = Enumerable.Range(0, 8).Select(index => service.UpdateAsync(
            folder.Id,
            folder.OwnerUserId,
            new WebFolder { Name = $"并发名称-{index}" }));
        var results = await Task.WhenAll(updates);

        results.All(result => result?.Id == folder.Id).ShouldBeTrue();
        var persisted = await fixture.Db.WebFolders.Find(item => item.Id == folder.Id).ToListAsync();
        persisted.ShouldHaveSingleItem();
        persisted[0].RenameFence.ShouldBe(8);
    }

    [Fact]
    public async Task 新租约写入围栏后_过期租约不能再覆盖文件夹()
    {
        await using var fixture = await RenameFenceMongoFixture.CreateAsync();
        var folder = new WebFolder
        {
            Id = "folder-1",
            OwnerUserId = "owner-1",
            Name = "原名称",
            RenameFence = 1,
        };
        await fixture.Db.WebFolders.InsertOneAsync(folder);

        var advance = await fixture.Db.WebFolders.UpdateOneAsync(
            WebFolderService.BuildRenameFenceAdvanceFilter(folder.Id, folder.OwnerUserId, 2),
            Builders<WebFolder>.Update.Set(item => item.RenameFence, 2));
        advance.ModifiedCount.ShouldBe(1);

        var expiredOwner = await fixture.Db.WebFolders.UpdateOneAsync(
            WebFolderService.BuildRenameFenceOwnerFilter(folder.Id, folder.OwnerUserId, 1),
            Builders<WebFolder>.Update.Set(item => item.Name, "过期写入"));
        expiredOwner.MatchedCount.ShouldBe(0);

        var currentOwner = await fixture.Db.WebFolders.UpdateOneAsync(
            WebFolderService.BuildRenameFenceOwnerFilter(folder.Id, folder.OwnerUserId, 2),
            Builders<WebFolder>.Update.Set(item => item.Name, "当前写入"));
        currentOwner.ModifiedCount.ShouldBe(1);

        var persisted = await fixture.Db.WebFolders.Find(item => item.Id == folder.Id).SingleAsync();
        persisted.Name.ShouldBe("当前写入");
        persisted.RenameFence.ShouldBe(2);
    }

    private sealed class RenameFenceMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private RenameFenceMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<RenameFenceMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new RenameFenceMongoFixture(
                client,
                connectionString,
                $"web_folder_fence_test_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
