using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.ModelUpgrades;
using Xunit;

namespace PrdAgent.Tests;

public sealed class ModelBindingProbeMongoTests
{
    [Theory]
    [InlineData("chat", "openai", "v1/chat/completions", true)]
    [InlineData("chat", "claude", "v1/messages", true)]
    [InlineData("generation", "openai", "v1/images/generations", true)]
    [InlineData("chat", "openai", "v1/responses", false)]
    [InlineData("generation", "openai", "v1/images/edits", false)]
    [InlineData("chat", "openai", "admin/delete", false)]
    public void KnownRequestBodiesCannotBeSentToAnUnregisteredPath(string type, string protocol, string path, bool expected)
        => Assert.Equal(expected, ModelBindingProbeService.IsKnownProbePath(type, protocol, path));

    [Fact, Trait("Category", "Integration")]
    public async Task ExplicitBindingIntentIsIdempotentScopedAndDoesNotChangeLiveConfiguration()
    {
        var uri = Environment.GetEnvironmentVariable("MODEL_BINDING_TEST_MONGO_URI");
        Assert.False(string.IsNullOrEmpty(uri), "点名测试需要本地 MODEL_BINDING_TEST_MONGO_URI，不连接线上数据库。");
        var url = new MongoUrl(uri); Assert.All(url.Servers, server => Assert.Contains(server.Host, new[] { "localhost", "127.0.0.1", "::1" }));
        var client = new MongoClient(uri); var name = "binding_probe_test_" + Guid.NewGuid().ToString("N");
        var db = client.GetDatabase(name); var now = DateTime.UtcNow;
        BsonDocument Doc(string id) => new() { { "_id", id }, { "TenantId", "internal" }, { "Enabled", true }, { "UpdatedAt", now } };
        var logical = Doc("logical"); logical["PublicId"] = "custom-future-model"; logical["ModelType"] = "chat"; logical["IdentityKind"] = "fixed";
        var model = Doc("model"); model["PlatformId"] = "provider"; model["ModelName"] = "future-chat-2027";
        model["PriceCurrency"] = "USD"; model["PriceObservedAt"] = now; model["InputPricePerMillion"] = new Decimal128(1m); model["OutputPricePerMillion"] = new Decimal128(2m);
        var provider = Doc("provider"); provider["Name"] = "Official"; provider["PlatformType"] = "openai"; provider["ApiKeyEncrypted"] = "sentinel-key-never-return";
        var offering = Doc("offering"); offering["LogicalModelId"] = "logical"; offering["TargetKind"] = "model"; offering["TargetId"] = "model";
        var actor = new TenantAccessContext("internal", "Internal", true, "console-admin", "admin", "membership", 1, "admin", [], "map-user");
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?> { ["LlmGateway:ModelUpgrades:CanaryEnabled"] = "true" }).Build();
        var service = new ModelBindingProbeService(db, config, "internal");
        var queue = db.GetCollection<BsonDocument>(ModelUpgradeService.ValidationCollectionName);
        try
        {
            foreach (var pair in new[] { ("llmgw_logical_models", logical), ("llmgw_models", model), ("llmgw_platforms", provider), ("llmgw_model_offerings", offering) })
                await db.GetCollection<BsonDocument>(pair.Item1).InsertOneAsync(pair.Item2);
            var request = new ModelBindingProbeWrite(Guid.NewGuid().ToString(), "arena.run::chat", .1m);
            var first = await service.StartAsync(actor, "logical", "offering", request, default);
            var second = await service.StartAsync(actor, "logical", "offering", request, default);
            Assert.Equal(System.Text.Json.JsonSerializer.Serialize(first), System.Text.Json.JsonSerializer.Serialize(second));
            Assert.Equal(1, await queue.CountDocumentsAsync(new BsonDocument()));
            var job = await queue.Find(new BsonDocument()).SingleAsync();
            Assert.Equal("offering", job["CandidateOfferingId"].AsString); Assert.Equal("map-user", job["ActorUserId"].AsString);
            Assert.Equal("manual", job["ExecutionRequestedBy"].AsString); Assert.Equal("binding-test", job["Operation"].AsString);
            Assert.Equal(ModelUpgradeWire.Fingerprint(offering), job["OfferingVersion"].AsString);
            Assert.DoesNotContain("sentinel-key", System.Text.Json.JsonSerializer.Serialize(first));
            var changed = await Assert.ThrowsAsync<ModelUpgradeException>(() => service.StartAsync(actor, "logical", "offering", request with { MaxCostUsd = .2m }, default));
            Assert.Equal("PROBE_REQUEST_CHANGED", changed.Code);
            var foreign = await Assert.ThrowsAsync<ModelUpgradeException>(() => service.ReadAsync(actor with { TenantId = "other" }, "logical", "offering", job["_id"].AsString, default));
            Assert.Equal("NOT_FOUND", foreign.Code);
            await Assert.ThrowsAsync<ModelUpgradeException>(() => service.StartAsync(actor, "logical", "offering", request with { ClientRequestId = Guid.NewGuid().ToString(), MaxCostUsd = 2m }, default));
            await db.GetCollection<BsonDocument>("llmgw_models").UpdateOneAsync(new BsonDocument("_id", "model"), new BsonDocument("$set", new BsonDocument("PriceObservedAt", now.AddDays(-31))));
            var stale = await Assert.ThrowsAsync<ModelUpgradeException>(() => service.StartAsync(actor, "logical", "offering", request with { ClientRequestId = Guid.NewGuid().ToString() }, default));
            Assert.Equal("PROBE_PRICE_REQUIRED", stale.Code); Assert.Equal(1, await queue.CountDocumentsAsync(new BsonDocument()));
            await queue.UpdateOneAsync(new BsonDocument("_id", job["_id"]), new BsonDocument("$set", new BsonDocument { { "Status", "succeeded" }, { "OutputUrl", "https://example.invalid/old-proof.png" } }));
            await db.GetCollection<BsonDocument>("llmgw_model_offerings").UpdateOneAsync(new BsonDocument("_id", "offering"), new BsonDocument("$set", new BsonDocument("EndpointPath", "v1/chat/completions")));
            var outdated = System.Text.Json.JsonSerializer.Serialize(await service.ReadLatestAsync(actor, "logical", "offering", default));
            Assert.Contains("stale", outdated); Assert.DoesNotContain("old-proof.png", outdated);
            await db.GetCollection<BsonDocument>("llmgw_model_offerings").ReplaceOneAsync(new BsonDocument("_id", "offering"), offering);
            var live = await db.GetCollection<BsonDocument>("llmgw_logical_models").Find(new BsonDocument("_id", "logical")).SingleAsync();
            Assert.Equal(logical, live); Assert.Equal(offering, await db.GetCollection<BsonDocument>("llmgw_model_offerings").Find(new BsonDocument("_id", "offering")).SingleAsync());
        }
        finally { await client.DropDatabaseAsync(name); }
    }
}
