using System.Net;
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
    [InlineData("protocol")]
    [InlineData("endpoint")]
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
                "protocol" => ("Protocol", (BsonValue)"openai-responses"),
                "endpoint" => ("EndpointPath", (BsonValue)"/changed-endpoint"),
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
        var proof = await f.Offerings.Find(new BsonDocument("_id", "target-offering")).SingleAsync();
        var mapping = await f.Catalog.BuildSwitchAsync(Fixture.Tenant, "source",
            new ModelUpgradeTarget { OfferingId = "source-offering", ModelId = "old-model", ProviderId = "provider", UpstreamModelId = "old-upstream" },
            new ModelUpgradeCandidate { ModelId = "new-model", ProviderId = "provider", UpstreamModelId = "new-upstream",
                ValidationRoute = new() { OfferingId = "target-offering", OfferingVersion = ModelUpgradeWire.Fingerprint(proof) } });
        Assert.Equal(mapping.Source.LogicalId, mapping.Target.LogicalId);
        Assert.Empty(await f.Catalog.ValidateAsync(mapping, [], default));
        await f.Logicals.UpdateOneAsync(new BsonDocument("_id", "target"), Builders<BsonDocument>.Update.Set("Enabled", false));
        Assert.NotEmpty(await f.Catalog.ValidateAsync(mapping, [], default));
    }

    [Fact]
    public async Task ExplicitOfferingWireNameCanDifferFromPhysicalCatalogName()
    {
        await using var f = new Fixture();
        await f.SeedAsync();
        await f.Offerings.UpdateOneAsync(new BsonDocument("_id", "target-offering"),
            Builders<BsonDocument>.Update.Set("UpstreamModelId", "explicit-wire-name"));
        var mapping = await f.Catalog.BuildAsync(Fixture.Tenant, "source", "target");
        Assert.Equal("explicit-wire-name", mapping.Target.UpstreamModelId);
        Assert.Empty(await f.Catalog.ValidateAsync(mapping, [], default));
    }

    [Fact]
    public async Task SourceAndTargetIdentitiesCannotBeBorrowedFromAnotherTenant()
    {
        await using var f = new Fixture();
        await f.SeedAsync();
        await Assert.ThrowsAsync<ModelReferenceException>(() => f.Catalog.BuildAsync("other-tenant", "source", "target"));
    }

    [Theory]
    [InlineData("mongodb://example.net:27912")]
    [InlineData("mongodb://user:password@127.0.0.1:27912")]
    [InlineData("mongodb+srv://localhost")]
    [InlineData("mongodb://127.0.0.1:27912/?tls=true")]
    [InlineData("mongodb://127.0.0.1:27912/business_database")]
    public void IntegrationFixtureRejectsNonLocalOrCredentialBearingUris(string uri)
        => Assert.Throws<InvalidOperationException>(() => LoopbackMongoUri(uri));

    [Theory]
    [InlineData("mongodb://127.0.0.1:27912")]
    [InlineData("mongodb://localhost:27913")]
    public void IntegrationFixtureAcceptsOnlyExplicitLoopbackPorts(string uri)
        => Assert.Equal(uri, LoopbackMongoUri(uri));

    private static string LoopbackMongoUri(string? configured)
    {
        var text = configured ?? "mongodb://127.0.0.1:27912";
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme != "mongodb"
            || uri.Port is < 1 or > 65535 || uri.UserInfo.Length != 0 || uri.Query.Length != 0
            || uri.Fragment.Length != 0 || uri.AbsolutePath is not ("" or "/")
            || !(string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase)
                 || IPAddress.TryParse(uri.Host, out var address) && IPAddress.IsLoopback(address)))
            throw new InvalidOperationException("模型引用集成测试仅允许无认证、无参数的显式本机 Mongo 端口。");
        return text;
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
            var settings = MongoClientSettings.FromConnectionString(LoopbackMongoUri(Environment.GetEnvironmentVariable("MODEL_REFERENCE_TEST_MONGO_URI")));
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
