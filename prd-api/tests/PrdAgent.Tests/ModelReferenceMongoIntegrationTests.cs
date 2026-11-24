using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.ModelReferences;
using Xunit;

namespace PrdAgent.Tests;

public sealed class ModelReferenceMongoIntegrationTests
{
    private sealed class Runtime : IRuntimeModelReferenceSnapshotProvider
    {
        public Task<RuntimeModelReferenceSnapshot> ReadAsync(ReferenceMigrationMapping m, CancellationToken ct) => Task.FromResult(new RuntimeModelReferenceSnapshot(true, []));
    }
    private sealed class Target : IModelReferenceTargetValidator
    {
        public Task<IReadOnlyList<string>> ValidateAsync(ReferenceMigrationMapping m, IReadOnlyList<string> keys, CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);
        public Task<IReadOnlyList<string>> ValidateFindingsAsync(ReferenceMigrationMapping m, IReadOnlyList<ReferenceFinding> findings, CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);
    }
    [Fact, Trait("Category", "Integration")]
    public async Task RealMongoProjectionCasSchemaAndJournalRoundtrip()
    {
        var uri = Environment.GetEnvironmentVariable("MODEL_REFERENCE_TEST_MONGO_URI");
        Assert.False(string.IsNullOrEmpty(uri), "点名集成测试必须显式配置本地 MODEL_REFERENCE_TEST_MONGO_URI。");
        var url = new MongoUrl(uri); Assert.All(url.Servers, host => Assert.Contains(host.Host, new[] { "localhost", "127.0.0.1", "::1" }));
        var settings = MongoClientSettings.FromUrl(url); settings.ServerSelectionTimeout = TimeSpan.FromSeconds(5);
        var client = new MongoClient(settings); var suffix = Guid.NewGuid().ToString("N");
        var gwName = "reference_test_gw_" + suffix; var mapName = "reference_test_map_" + suffix;
        var gw = client.GetDatabase(gwName); var map = client.GetDatabase(mapName);
        try
        {
            var mapping = new ReferenceMigrationMapping { TenantId = "internal", Source = new() { LogicalId = "old", PublicId = "old-public" }, Target = new() { LogicalId = "new", PublicId = "new-public" } };
            var key = map.GetCollection<BsonDocument>("agent_api_keys");
            await key.InsertOneAsync(BsonDocument.Parse("{_id:'key',OwnerUserId:'owner',OpenApiChatModels:['old-public'],ApiKeyEncrypted:'sentinel-secret'}"));
            var groups = map.GetCollection<BsonDocument>("model_lab_groups");
            await groups.InsertOneAsync(BsonDocument.Parse("{_id:'group',OwnerUserId:'owner',Models:[{LogicalModelId:'old',PlatformId:'p',ModelId:'physical'},{PlatformId:'other',ModelId:'old-public'}]}"));
            var store = new MongoModelReferenceStore(gw, map, "internal"); var engine = new ModelReferenceEngine(store, "internal", new Runtime(), new Target());
            var plan = await engine.PlanAsync(mapping, "admin", Guid.NewGuid().ToString());
            Assert.True(plan.Coverage.CanComplete); Assert.DoesNotContain("sentinel-secret", plan.ToJson());
            // Real $set and equality CAS must reject an edited array member and preserve unrelated fields.
            await groups.UpdateOneAsync(new BsonDocument("_id", "group"), new BsonDocument("$set", new BsonDocument("Models.0.ModelId", "concurrent-change")));
            var result = await engine.ApplyAsync(plan.Id, "internal", plan.Revision);
            Assert.Equal("conflict", result.Status);
            Assert.Equal("concurrent-change", (await groups.Find(new BsonDocument("_id", "group")).SingleAsync())["Models"][0]["ModelId"]);
            Assert.Equal("sentinel-secret", (await key.Find(new BsonDocument("_id", "key")).SingleAsync())["ApiKeyEncrypted"]);
            // Same intent can reconcile an acknowledged write that happened before its journal acknowledgement.
            var second = await engine.PlanAsync(mapping, "admin", Guid.NewGuid().ToString());
            foreach (var change in second.Changes) Assert.True(await store.IsAppliedAsync(change, "internal", default) || await store.CompareAndSwapAsync(change, "internal", default));
            var resumed = await engine.ApplyAsync(second.Id, "internal", second.Revision);
            Assert.Equal("completed", resumed.Status); Assert.True(resumed.Coverage.Verified);
            var current = await groups.Find(new BsonDocument("_id", "group")).SingleAsync();
            Assert.Equal("new", current["Models"][0]["LogicalModelId"]); Assert.Equal("old-public", current["Models"][1]["ModelId"]); // pair identity is not public-name matching
            // A new unknown future configuration path invalidates the previously green journal.
            await key.UpdateOneAsync(new BsonDocument("_id", "key"), new BsonDocument("$set", new BsonDocument("FutureConfig.ModelId", "old-public")));
            var verify = await engine.VerifyPlanAsync(second.Id, "internal", resumed.Revision);
            Assert.False(verify.Coverage.Verified); Assert.True(verify.Coverage.Unknown > 0);
            Assert.False((await engine.GetAsync(second.Id, "internal")).Coverage.Verified);
            var snapshots = map.GetCollection<BsonDocument>(MongoRuntimeModelReferenceSnapshotProvider.CollectionName);
            var fresh = ModelRuntimeReferenceReaderTests.Row(DateTime.UtcNow, "new-instance"); fresh["TenantId"] = "internal"; fresh["DeploymentScope"] = "main-new-revision";
            await snapshots.InsertOneAsync(fresh);
            var provider = new MongoRuntimeModelReferenceSnapshotProvider(map, "project::main", "main-new-revision", "main", "461076339cbf20a310d4cedd2403a08a2941ae87");
            Assert.True((await provider.ReadAsync(mapping, default)).Complete);
            var old = ModelRuntimeReferenceReaderTests.Row(DateTime.UtcNow, "old-still-heartbeating"); old["TenantId"] = "internal"; old["DeploymentScope"] = "main-old-revision"; old["ActualCommit"] = new string('a', 40);
            await snapshots.InsertOneAsync(old);
            Assert.False((await provider.ReadAsync(mapping, default)).Complete); // query must not pre-filter old revision

        }
        finally { await client.DropDatabaseAsync(gwName); await client.DropDatabaseAsync(mapName); }
    }
}
