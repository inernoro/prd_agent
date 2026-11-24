using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Authentication;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Authentication;

/// <summary>
/// 稳定冒烟账号补齐权限那条更新，必须能在真实库里的真实文档形态上跑通。
///
/// 2026-09-15 Codex 指出第一版补齐用的 $addToSet / $pullAll 在 PermAllow / PermDeny 为 BSON null 时整条报错，
/// 而事故账号（09-01 旧构建自动开号）正是这个形态，新开的号 PermDeny 也是 null。
/// 这组用例直接拿真 Mongo 复现：先证明旧写法在事故文档上确实报错，再证明新写法在
/// null / 缺失 / 已有数组三种形态下都只补缺项、只摘矩阵项、其余原样保留。
/// CI 的 Server Build &amp; Test 自带 mongo:8.0 服务，与线上部署同版本。
/// </summary>
public sealed class StableSmokePermissionReconcileUpdateTests
{
    private static readonly string[] Grant = ["users.read", "authz.manage"];

    [Fact]
    public async Task 事故账号形态_两个字段都是null_旧写法确实报错()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var user = await SeedAsync(fixture, permAllow: null, permDeny: null);
        (await RawAsync(fixture, user.UserId))["PermAllow"].IsBsonNull.ShouldBeTrue("夹具必须复现 BSON null，而不是字段缺失");

        var legacy = Builders<User>.Update
            .AddToSetEach(item => item.PermAllow, Grant)
            .PullAll(item => item.PermDeny, StableSmokeIdentityPolicy.RequiredPermissions);
        var ex = await Should.ThrowAsync<MongoWriteException>(() =>
            fixture.Db.Users.UpdateOneAsync(Filter(user.UserId), legacy));
        ex.Message.ShouldContain("non-array", customMessage: "旧写法应当因为 null 不是数组而被服务端拒绝");
    }

    [Fact]
    public async Task 事故账号形态_两个字段都是null_新写法补齐为数组()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var user = await SeedAsync(fixture, permAllow: null, permDeny: null);

        await fixture.Db.Users.UpdateOneAsync(
            Filter(user.UserId),
            StableSmokePermissionReconcileUpdate.Build(Grant, StableSmokeIdentityPolicy.RequiredPermissions));

        var after = await fixture.Db.Users.Find(Filter(user.UserId)).SingleAsync();
        after.PermAllow.ShouldBe(Grant);
        after.PermDeny.ShouldNotBeNull();
        after.PermDeny.ShouldBeEmpty();
    }

    [Fact]
    public async Task 字段整个缺失的旧文档_同样补齐()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var userId = "u-" + Guid.NewGuid().ToString("N")[..8];
        await fixture.Db.Users.Database.GetCollection<BsonDocument>("users").InsertOneAsync(new BsonDocument
        {
            // users 集合的 _id 就是 UserId（见 BsonClassMapRegistration.RegisterUser）
            { "_id", userId },
            { "Username", "stsmk-legacy-" + userId },
            { "PasswordHash", "x" },
            { "CreatedAt", DateTime.UtcNow },
        });

        await fixture.Db.Users.UpdateOneAsync(
            Filter(userId),
            StableSmokePermissionReconcileUpdate.Build(Grant, StableSmokeIdentityPolicy.RequiredPermissions));

        var raw = await RawAsync(fixture, userId);
        raw["PermAllow"].AsBsonArray.Select(item => item.AsString).ShouldBe(Grant);
        raw["PermDeny"].AsBsonArray.ShouldBeEmpty();
    }

    [Fact]
    public async Task 已有清单_只补缺项只摘矩阵项_其余项与顺序原样保留()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var user = await SeedAsync(
            fixture,
            permAllow: ["custom.keep", "access", "users.read"],
            permDeny: ["users.write", "custom.deny"]);

        await fixture.Db.Users.UpdateOneAsync(
            Filter(user.UserId),
            StableSmokePermissionReconcileUpdate.Build(Grant, StableSmokeIdentityPolicy.RequiredPermissions));

        var after = await fixture.Db.Users.Find(Filter(user.UserId)).SingleAsync();
        after.PermAllow.ShouldBe(["custom.keep", "access", "users.read", "authz.manage"],
            customMessage: "管理员放行的自定义项与既有顺序不能动，已有的 users.read 不能重复追加");
        after.PermDeny.ShouldBe(["custom.deny"],
            customMessage: "只摘矩阵要求的 users.write，管理员的自定义拒绝项必须保留");
    }

    [Fact]
    public async Task 重复执行是幂等的()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var user = await SeedAsync(fixture, permAllow: null, permDeny: null);
        var update = StableSmokePermissionReconcileUpdate.Build(Grant, StableSmokeIdentityPolicy.RequiredPermissions);

        await fixture.Db.Users.UpdateOneAsync(Filter(user.UserId), update);
        await fixture.Db.Users.UpdateOneAsync(Filter(user.UserId), update);

        var after = await fixture.Db.Users.Find(Filter(user.UserId)).SingleAsync();
        after.PermAllow.ShouldBe(Grant);
    }

    private static FilterDefinition<User> Filter(string userId) => Builders<User>.Filter.Eq(item => item.UserId, userId);

    private static async Task<BsonDocument> RawAsync(MongoFixture fixture, string userId)
        => await fixture.Db.Users.Database.GetCollection<BsonDocument>("users")
            .Find(new BsonDocument("_id", userId)).SingleAsync();

    private static async Task<User> SeedAsync(MongoFixture fixture, List<string>? permAllow, List<string>? permDeny)
    {
        var user = new User
        {
            UserId = "u-" + Guid.NewGuid().ToString("N")[..8],
            Username = "stsmk-" + Guid.NewGuid().ToString("N")[..8],
            PasswordHash = "x",
            SystemRoleKey = StableSmokeIdentityPolicy.ProvisionedSystemRoleKey,
            PermAllow = permAllow,
            PermDeny = permDeny,
            CreatedAt = DateTime.UtcNow,
        };
        await fixture.Db.Users.InsertOneAsync(user);
        return user;
    }

    private sealed class MongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private MongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<MongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new MongoFixture(client, connectionString, $"stable_smoke_reconcile_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
