using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.ModelReferences;
using PrdAgent.LlmGw.ModelUpgrades;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

[Trait("Category", "Integration")]
public sealed class ModelReferenceRouteIntegrityTests
{
    [Theory]
    [InlineData("disabled")]
    [InlineData("deleted")]
    [InlineData("different-model")]
    [InlineData("different-logical")]
    [InlineData("different-tenant")]
    [InlineData("different-upstream")]
    [InlineData("exchange")]
    public async Task TargetRouteChangedAfterPlanCannotRemainValidated(string mutation)
    {
        await using var f = new Fixture();
        await f.SeedAsync();
        var mapping = await f.Catalog.BuildAsync(Fixture.Tenant, "source", "target");
        Assert.Empty(await f.Catalog.ValidateAsync(mapping, [], default));
        if (mutation == "deleted")
            await f.Offerings.DeleteOneAsync(new BsonDocument("_id", "target-offering"));
        else
        {
            var (field, value) = mutation switch
            {
                "disabled" => ("Enabled", (BsonValue)false),
                "different-model" => ("TargetId", (BsonValue)"another-model"),
                "different-logical" => ("LogicalModelId", (BsonValue)"source"),
                "different-tenant" => ("TenantId", (BsonValue)"other-tenant"),
                "different-upstream" => ("UpstreamModelId", (BsonValue)"another-upstream"),
                _ => ("TargetKind", (BsonValue)"exchange")
            };
            await f.Offerings.UpdateOneAsync(new BsonDocument("_id", "target-offering"),
                Builders<BsonDocument>.Update.Set(field, value));
        }
        // logical/model/provider remain enabled throughout; only the route changed.
        Assert.NotEmpty(await f.Catalog.ValidateAsync(mapping, [], default));
    }

    [Fact]
    public async Task StablePromotionAcceptsEnabledSamePurposeProofLogicalAndRejectsRetiredProof()
    {
        await using var f = new Fixture();
        await f.SeedAsync();
        var mapping = await f.Catalog.BuildSwitchAsync(Fixture.Tenant, "source",
            new ModelUpgradeTarget { OfferingId = "source-offering", ModelId = "old-model", ProviderId = "provider", UpstreamModelId = "old-upstream" },
            new ModelUpgradeCandidate { ModelId = "new-model", ProviderId = "provider", UpstreamModelId = "new-upstream",
                ValidationRoute = new() { OfferingId = "target-offering" } });
        Assert.Equal(mapping.Source.LogicalId, mapping.Target.LogicalId);
        Assert.Empty(await f.Catalog.ValidateAsync(mapping, [], default));
        await f.Logicals.UpdateOneAsync(new BsonDocument("_id", "target"), Builders<BsonDocument>.Update.Set("Enabled", false));
        Assert.NotEmpty(await f.Catalog.ValidateAsync(mapping, [], default));
    }

    [Fact]
    public async Task SourceAndTargetIdentitiesCannotBeBorrowedFromAnotherTenant()
    {
        await using var f = new Fixture();
        await f.SeedAsync();
        await Assert.ThrowsAsync<ModelReferenceException>(() => f.Catalog.BuildAsync("other-tenant", "source", "target"));
    }

    private sealed class Fixture : IAsyncDisposable
    {
        public const string Tenant = "tenant_map_internal";
        private readonly MongoClient _client;
        private readonly string _name = "model_reference_route_test_" + Guid.NewGuid().ToString("N");
        public IMongoDatabase Db { get; }
        public ModelReferenceCatalog Catalog { get; }
        public IMongoCollection<BsonDocument> Logicals => Db.GetCollection<BsonDocument>("llmgw_logical_models");
        public IMongoCollection<BsonDocument> Offerings => Db.GetCollection<BsonDocument>("llmgw_model_offerings");

        public Fixture()
        {
            var settings = MongoClientSettings.FromConnectionString(Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                ?? "mongodb://127.0.0.1:27912");
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            _client = new MongoClient(settings);
            Db = _client.GetDatabase(_name);
            Catalog = new ModelReferenceCatalog(Db, Db, Tenant);
        }

        public async Task SeedAsync()
        {
            BsonDocument Logical(string id) => new()
            {
                { "_id", id }, { "TenantId", Tenant }, { "PublicId", id + "-public" }, { "Enabled", true },
                { "ModelType", "chat" }, { "Capabilities", new BsonArray { "chat" } }, { "AllowedAppCallerCodes", new BsonArray() }
            };
            BsonDocument Model(string id, string upstream) => new()
            {
                { "_id", id }, { "TenantId", Tenant }, { "PlatformId", "provider" }, { "ModelName", upstream }, { "Enabled", true },
                { "Capabilities", new BsonArray { new BsonDocument { { "Type", "chat" }, { "Value", true } } } }
            };
            BsonDocument Offering(string id, string logical, string model) => new()
            {
                { "_id", id }, { "TenantId", Tenant }, { "LogicalModelId", logical }, { "TargetKind", "model" },
                { "TargetId", model }, { "Enabled", true }
            };
            await Logicals.InsertManyAsync([Logical("source"), Logical("target")]);
            await Db.GetCollection<BsonDocument>("llmgw_models").InsertManyAsync([Model("old-model", "old-upstream"), Model("new-model", "new-upstream")]);
            await Db.GetCollection<BsonDocument>("llmgw_platforms").InsertOneAsync(new BsonDocument { { "_id", "provider" }, { "TenantId", Tenant }, { "Enabled", true } });
            await Offerings.InsertManyAsync([Offering("source-offering", "source", "old-model"), Offering("target-offering", "target", "new-model")]);
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_name);
    }
}
