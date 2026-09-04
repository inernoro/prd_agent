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

    [Fact]
    public async Task 新租约接管名称占用后_旧租约不能再次修复该占用()
    {
        await using var fixture = await RenameFenceMongoFixture.CreateAsync();
        const string userId = "owner-claim-fence";
        const string folderId = "folder-claim-fence";
        var normalizedName = WebFolderService.NormalizeName("围栏目标");
        var claimId = WebFolderService.BuildNameClaimId(userId, normalizedName);
        var claims = fixture.Db.Database.GetCollection<BsonDocument>("web_folder_name_claims");
        await claims.InsertOneAsync(new BsonDocument
        {
            ["_id"] = claimId,
            ["FolderId"] = folderId,
            ["OwnerUserId"] = userId,
            ["NormalizedName"] = normalizedName,
            ["RenameOperationId"] = "operation-old",
            ["Fence"] = 1L,
        });

        var takeover = await claims.UpdateOneAsync(
            WebFolderService.BuildNameClaimOwnershipFilter(
                userId, normalizedName, folderId, "operation-new", 2),
            Builders<BsonDocument>.Update
                .Set("RenameOperationId", "operation-new")
                .Set("Fence", 2L));
        takeover.ModifiedCount.ShouldBe(1);

        var expiredRepair = await claims.UpdateOneAsync(
            WebFolderService.BuildOwnedNameClaimFilter(
                userId, normalizedName, folderId, "operation-old", 1),
            Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow));
        expiredRepair.MatchedCount.ShouldBe(0);

        var currentRepair = await claims.UpdateOneAsync(
            WebFolderService.BuildOwnedNameClaimFilter(
                userId, normalizedName, folderId, "operation-new", 2),
            Builders<BsonDocument>.Update.Set("UpdatedAt", DateTime.UtcNow));
        currentRepair.MatchedCount.ShouldBe(1);
    }

    [Fact]
    public async Task 重命名进程退出且租约过期后_创建会回收悬空目标占用()
    {
        await using var fixture = await RenameFenceMongoFixture.CreateAsync();
        const string userId = "owner-abandoned-claim";
        const string oldFolderId = "folder-abandoned-claim";
        const string operationId = "operation-abandoned";
        const long fence = 7;
        var normalizedName = WebFolderService.NormalizeName("可回收目标");
        await fixture.Db.WebFolders.InsertOneAsync(new WebFolder
        {
            Id = oldFolderId,
            OwnerUserId = userId,
            Name = "仍是旧名称",
        });
        await fixture.Db.Database.GetCollection<BsonDocument>("web_folder_name_claims").InsertOneAsync(
            new BsonDocument
            {
                ["_id"] = WebFolderService.BuildNameClaimId(userId, normalizedName),
                ["FolderId"] = oldFolderId,
                ["OwnerUserId"] = userId,
                ["NormalizedName"] = normalizedName,
                ["RenameOperationId"] = operationId,
                ["Fence"] = fence,
            });
        await fixture.Db.Database.GetCollection<BsonDocument>("web_folder_rename_locks").InsertOneAsync(
            new BsonDocument
            {
                ["_id"] = oldFolderId,
                ["OperationId"] = operationId,
                ["Fence"] = fence,
                ["ExpiresAt"] = DateTime.UtcNow.AddMinutes(-1),
            });
        var service = CreateService(fixture.Db);

        var created = await service.CreateAsync(userId, new WebFolder { Name = "可回收目标" });

        created.Id.ShouldNotBe(oldFolderId);
        WebFolderService.NormalizeName(created.Name).ShouldBe(normalizedName);
    }

    [Fact]
    public async Task 历史冲突快照不能覆盖另一个操作已持有的名称占用()
    {
        await using var fixture = await RenameFenceMongoFixture.CreateAsync();
        const string userId = "owner-stale-repair";
        const string targetName = "并发目标";
        var normalizedName = WebFolderService.NormalizeName(targetName);
        await fixture.Db.WebFolders.InsertManyAsync(new[]
        {
            new WebFolder { Id = "folder-source", OwnerUserId = userId, Name = "原名称" },
            new WebFolder { Id = "folder-collision", OwnerUserId = userId, Name = targetName },
        });
        var claims = fixture.Db.Database.GetCollection<BsonDocument>("web_folder_name_claims");
        await claims.InsertOneAsync(new BsonDocument
        {
            ["_id"] = WebFolderService.BuildNameClaimId(userId, normalizedName),
            ["FolderId"] = "folder-concurrent-owner",
            ["OwnerUserId"] = userId,
            ["NormalizedName"] = normalizedName,
        });

        await Should.ThrowAsync<InvalidOperationException>(() => CreateService(fixture.Db).UpdateAsync(
            "folder-source", userId, new WebFolder { Name = targetName }));

        var persistedClaim = await claims.Find(
            Builders<BsonDocument>.Filter.Eq("_id", WebFolderService.BuildNameClaimId(userId, normalizedName)))
            .SingleAsync();
        persistedClaim["FolderId"].AsString.ShouldBe("folder-concurrent-owner");
    }

    [Fact]
    public async Task 创建与改名并发后_旧名称仍可创建且名称占用指向当前实体()
    {
        await using var fixture = await RenameFenceMongoFixture.CreateAsync();
        const string userId = "owner-create-rename-snapshot";
        var service = CreateService(fixture.Db);

        for (var index = 0; index < 6; index++)
        {
            var oldName = $"旧名称-{index}";
            var nextName = $"新名称-{index}";
            var original = await service.CreateAsync(userId, new WebFolder { Name = oldName });
            var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var renameTask = Task.Run(async () =>
            {
                await gate.Task;
                return await service.UpdateAsync(original.Id, userId, new WebFolder { Name = nextName });
            });
            var createTask = Task.Run(async () =>
            {
                await gate.Task;
                return await service.CreateAsync(userId, new WebFolder { Name = oldName });
            });

            gate.SetResult();
            await Task.WhenAll((Task)renameTask, createTask);
            await service.CreateAsync(userId, new WebFolder { Name = oldName });

            var persisted = await fixture.Db.WebFolders
                .Find(folder => folder.OwnerUserId == userId)
                .ToListAsync();
            persisted.Count(folder => WebFolderService.NormalizeName(folder.Name) == WebFolderService.NormalizeName(oldName))
                .ShouldBe(1);
            persisted.Count(folder => WebFolderService.NormalizeName(folder.Name) == WebFolderService.NormalizeName(nextName))
                .ShouldBe(1);
        }
    }

    [Fact]
    public async Task 无权更新不存在的文件夹_不创建重命名锁记录()
    {
        await using var fixture = await RenameFenceMongoFixture.CreateAsync();
        var service = CreateService(fixture.Db);

        var result = await service.UpdateAsync(
            "missing-folder", "owner-missing", new WebFolder { Name = "不会写入" });

        result.ShouldBeNull();
        var lockCount = await fixture.Db.Database
            .GetCollection<BsonDocument>("web_folder_rename_locks")
            .CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty);
        lockCount.ShouldBe(0);
    }

    [Fact]
    public async Task 删除与同名创建并发_不会复活旧实体形成重复文件夹()
    {
        await using var fixture = await RenameFenceMongoFixture.CreateAsync();
        const string userId = "owner-delete-create";
        var service = CreateService(fixture.Db);

        for (var index = 0; index < 8; index++)
        {
            var name = $"删除并发-{index}";
            var original = await service.CreateAsync(userId, new WebFolder { Name = name });
            var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var deleteTask = Task.Run(async () =>
            {
                await gate.Task;
                return await service.DeleteAsync(original.Id, userId);
            });
            var createTasks = Enumerable.Range(0, 8).Select(_ => Task.Run(async () =>
            {
                await gate.Task;
                return await service.CreateAsync(userId, new WebFolder { Name = name });
            })).ToArray();

            gate.SetResult();
            await Task.WhenAll(createTasks.Cast<Task>().Append(deleteTask));
            var final = await service.CreateAsync(userId, new WebFolder { Name = name });

            var normalizedName = WebFolderService.NormalizeName(name);
            var persisted = await fixture.Db.WebFolders
                .Find(folder => folder.OwnerUserId == userId)
                .ToListAsync();
            var matching = persisted
                .Where(folder => WebFolderService.NormalizeName(folder.Name) == normalizedName)
                .ToList();
            matching.ShouldHaveSingleItem();
            matching[0].Id.ShouldBe(final.Id);
        }
    }

    [Fact]
    public async Task 并发创建同名文件夹_只保留获胜实体的锁并最终化名称占用()
    {
        await using var fixture = await RenameFenceMongoFixture.CreateAsync();
        const string userId = "owner-concurrent-create";
        const string name = "并发创建";
        var service = CreateService(fixture.Db);

        var createTasks = Enumerable.Range(0, 12)
            .Select(_ => service.CreateAsync(userId, new WebFolder { Name = name }));
        var created = await Task.WhenAll(createTasks);
        var folderId = created.Select(folder => folder.Id).Distinct().ShouldHaveSingleItem();

        var folders = await fixture.Db.WebFolders
            .Find(folder => folder.OwnerUserId == userId)
            .ToListAsync();
        folders.ShouldHaveSingleItem();
        folders[0].Id.ShouldBe(folderId);

        var locks = await fixture.Db.Database
            .GetCollection<BsonDocument>("web_folder_rename_locks")
            .Find(FilterDefinition<BsonDocument>.Empty)
            .ToListAsync();
        locks.ShouldHaveSingleItem();
        locks[0]["_id"].AsString.ShouldBe(folderId);

        var normalizedName = WebFolderService.NormalizeName(name);
        var claim = await fixture.Db.Database
            .GetCollection<BsonDocument>("web_folder_name_claims")
            .Find(Builders<BsonDocument>.Filter.Eq(
                "_id", WebFolderService.BuildNameClaimId(userId, normalizedName)))
            .SingleAsync();
        claim["FolderId"].AsString.ShouldBe(folderId);
        claim.Contains("RenameOperationId").ShouldBeFalse();
        claim.Contains("Fence").ShouldBeFalse();
    }

    [Fact]
    public void 服务端权威名称键不会把兼容连字扩成普通字母()
    {
        WebFolderService.NormalizeName("ﬃ").ShouldNotBe(WebFolderService.NormalizeName("FFI"));
    }

    private static WebFolderService CreateService(MongoDbContext db) => new(
        db,
        Mock.Of<IHostedSiteService>(),
        Mock.Of<IDocumentService>(),
        NullLogger<WebFolderService>.Instance);

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
