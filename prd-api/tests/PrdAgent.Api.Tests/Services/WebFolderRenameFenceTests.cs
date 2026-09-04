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

    [Fact]
    public async Task 创建撞上重命名目标占用时_等待实体名称落定后再返回成功()
    {
        await using var fixture = await RenameFenceMongoFixture.CreateAsync();
        const string userId = "owner-create-rename";
        const string folderId = "folder-create-rename";
        const string targetName = "目标名称";
        var folder = new WebFolder
        {
            Id = folderId,
            OwnerUserId = userId,
            Name = "旧名称",
        };
        await fixture.Db.WebFolders.InsertOneAsync(folder);

        var normalizedTarget = WebFolderService.NormalizeName(targetName);
        var now = DateTime.UtcNow;
        await fixture.Db.Database.GetCollection<BsonDocument>("web_folder_name_claims").InsertOneAsync(
            new BsonDocument
            {
                ["_id"] = WebFolderService.BuildNameClaimId(userId, normalizedTarget),
                ["FolderId"] = folderId,
                ["OwnerUserId"] = userId,
                ["NormalizedName"] = normalizedTarget,
                ["CreatedAt"] = now,
                ["UpdatedAt"] = now,
            });

        var service = new WebFolderService(
            fixture.Db,
            Mock.Of<IHostedSiteService>(),
            Mock.Of<IDocumentService>(),
            NullLogger<WebFolderService>.Instance);

        var createTask = service.CreateAsync(userId, new WebFolder { Name = targetName });
        await Task.Delay(100);
        createTask.IsCompleted.ShouldBeFalse("目标名称还未写入实体时不能提前报告创建成功");

        await fixture.Db.WebFolders.UpdateOneAsync(
            item => item.Id == folderId && item.OwnerUserId == userId,
            Builders<WebFolder>.Update.Set(item => item.Name, targetName));

        var created = await createTask.WaitAsync(TimeSpan.FromSeconds(3));
        created.Id.ShouldBe(folderId);
        WebFolderService.NormalizeName(created.Name).ShouldBe(normalizedTarget);

        var persisted = await fixture.Db.WebFolders.Find(item => item.OwnerUserId == userId).ToListAsync();
        persisted.ShouldHaveSingleItem();
        WebFolderService.NormalizeName(persisted[0].Name).ShouldBe(normalizedTarget);
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
