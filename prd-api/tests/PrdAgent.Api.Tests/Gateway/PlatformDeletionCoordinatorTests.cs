using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Governance;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class PlatformDeletionCoordinatorTests
{
    private const string InternalTenantId = "tenant_map_internal";

    [Fact]
    public async Task ClaimedPlatform_DeletesGatewayCopyAndMapSource_ButKeepsHistory()
    {
        await using var database = await TestDatabase.CreateAsync();
        var gatewayPlatforms = database.Database.GetCollection<BsonDocument>("llmgw_platforms");
        var mapPlatforms = database.Database.GetCollection<BsonDocument>("llmplatforms");
        var logs = database.Database.GetCollection<BsonDocument>("llmrequestlogs");
        const string platformId = "legacy-provider";

        await gatewayPlatforms.InsertOneAsync(new BsonDocument
        {
            { "_id", platformId },
            { "TenantId", InternalTenantId },
            { "Name", "Legacy Provider" },
            { "SourceCollection", PlatformDeletionCoordinator.MapSourceCollection },
            { "Authority", "llm_gateway" },
        });
        await mapPlatforms.InsertOneAsync(new BsonDocument
        {
            { "_id", platformId },
            { "Name", "Legacy Provider" },
        });
        await logs.InsertOneAsync(new BsonDocument
        {
            { "_id", "historic-request" },
            { "PlatformId", platformId },
            { "Status", "succeeded" },
        });

        var target = await PlatformDeletionCoordinator.ResolveAsync(
            gatewayPlatforms, mapPlatforms, InternalTenantId, InternalTenantId, platformId);
        target.ShouldNotBeNull();
        target.Scope.ShouldBe(PlatformDeletionScope.GatewayAndMapSource);

        var result = await PlatformDeletionCoordinator.DeleteAsync(
            gatewayPlatforms, mapPlatforms, InternalTenantId, target);

        result.GatewayDeleted.ShouldBeTrue();
        result.MapSourceDeleted.ShouldBeTrue();
        (await gatewayPlatforms.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty)).ShouldBe(0);
        (await mapPlatforms.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty)).ShouldBe(0);
        (await logs.CountDocumentsAsync(Builders<BsonDocument>.Filter.Eq("PlatformId", platformId))).ShouldBe(1);
    }

    [Fact]
    public async Task ExternalTenant_DeletesOnlyItsGatewayProvider_AndCannotTouchMapSource()
    {
        await using var database = await TestDatabase.CreateAsync();
        var gatewayPlatforms = database.Database.GetCollection<BsonDocument>("llmgw_platforms");
        var mapPlatforms = database.Database.GetCollection<BsonDocument>("llmplatforms");
        const string tenantId = "tenant-external";
        const string platformId = "shared-looking-id";

        await gatewayPlatforms.InsertOneAsync(new BsonDocument
        {
            { "_id", platformId },
            { "TenantId", tenantId },
            { "Name", "Tenant Provider" },
            { "SourceCollection", PlatformDeletionCoordinator.MapSourceCollection },
        });
        await mapPlatforms.InsertOneAsync(new BsonDocument
        {
            { "_id", platformId },
            { "Name", "MAP Provider" },
        });

        var target = await PlatformDeletionCoordinator.ResolveAsync(
            gatewayPlatforms, mapPlatforms, tenantId, InternalTenantId, platformId);
        target.ShouldNotBeNull();
        target.Scope.ShouldBe(PlatformDeletionScope.GatewayOnly);

        var result = await PlatformDeletionCoordinator.DeleteAsync(
            gatewayPlatforms, mapPlatforms, tenantId, target);

        result.GatewayDeleted.ShouldBeTrue();
        result.MapSourceDeleted.ShouldBeFalse();
        (await gatewayPlatforms.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty)).ShouldBe(0);
        (await mapPlatforms.CountDocumentsAsync(Builders<BsonDocument>.Filter.Eq("_id", platformId))).ShouldBe(1);
    }

    [Fact]
    public async Task GatewayNativeIdCollision_WithMapSource_IsRejectedWithoutDeletingEitherSide()
    {
        await using var database = await TestDatabase.CreateAsync();
        var gatewayPlatforms = database.Database.GetCollection<BsonDocument>("llmgw_platforms");
        var mapPlatforms = database.Database.GetCollection<BsonDocument>("llmplatforms");
        const string platformId = "collision";

        await gatewayPlatforms.InsertOneAsync(new BsonDocument
        {
            { "_id", platformId },
            { "TenantId", InternalTenantId },
            { "Name", "Gateway Native" },
            { "SourceCollection", "llmgw_platforms" },
        });
        await mapPlatforms.InsertOneAsync(new BsonDocument
        {
            { "_id", platformId },
            { "Name", "Unrelated MAP Source" },
        });

        var target = await PlatformDeletionCoordinator.ResolveAsync(
            gatewayPlatforms, mapPlatforms, InternalTenantId, InternalTenantId, platformId);
        target.ShouldNotBeNull();
        target.Scope.ShouldBe(PlatformDeletionScope.Ambiguous);

        var error = await Should.ThrowAsync<PlatformDeletionException>(() =>
            PlatformDeletionCoordinator.DeleteAsync(
                gatewayPlatforms, mapPlatforms, InternalTenantId, target));

        error.FailureStage.ShouldBe("precondition");
        (await gatewayPlatforms.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty)).ShouldBe(1);
        (await mapPlatforms.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty)).ShouldBe(1);
    }

    [Fact]
    public async Task InternalTenant_CanRetireMapOnlyProvider_WithoutClaimRoundTrip()
    {
        await using var database = await TestDatabase.CreateAsync();
        var gatewayPlatforms = database.Database.GetCollection<BsonDocument>("llmgw_platforms");
        var mapPlatforms = database.Database.GetCollection<BsonDocument>("llmplatforms");
        const string platformId = "map-only";
        await mapPlatforms.InsertOneAsync(new BsonDocument
        {
            { "_id", platformId },
            { "Name", "MAP Only" },
        });

        var target = await PlatformDeletionCoordinator.ResolveAsync(
            gatewayPlatforms, mapPlatforms, InternalTenantId, InternalTenantId, platformId);
        target.ShouldNotBeNull();
        target.Scope.ShouldBe(PlatformDeletionScope.MapOnly);

        var result = await PlatformDeletionCoordinator.DeleteAsync(
            gatewayPlatforms, mapPlatforms, InternalTenantId, target);

        result.GatewayDeleted.ShouldBeFalse();
        result.MapSourceDeleted.ShouldBeTrue();
        (await mapPlatforms.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty)).ShouldBe(0);
    }

    private sealed class TestDatabase : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private TestDatabase(MongoClient client, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Database = client.GetDatabase(databaseName);
        }

        public IMongoDatabase Database { get; }

        public static async Task<TestDatabase> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://localhost:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(2);
            var client = new MongoClient(settings);
            try
            {
                await client.GetDatabase("admin")
                    .RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            }
            catch (Exception ex)
            {
                throw new Xunit.Sdk.XunitException($"MongoDB Provider 双域删除测试依赖不可用：{ex.Message}");
            }

            return new TestDatabase(client, $"llmgw_platform_delete_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
