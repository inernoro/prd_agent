using System.Net;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.ModelReferences;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

[Trait("Category", "Integration")]
public sealed class ModelReferenceBusinessMigrationTests
{
    [Fact]
    public async Task RetiredSourceCatalogDoesNotInvalidateMigrationOrEraseOriginalCapabilityContract()
    {
        await using var f = new Fixture();
        await f.SeedAsync("generation", Fixture.VisualCallers, openVisualTarget: true);
        await f.PutAsync("user_preferences", Preference("owner", "old-image"));
        var mapping = await new ModelReferenceCatalog(f.Db, f.Db, Fixture.Tenant).BuildAsync(Fixture.Tenant, "source", "target");
        var plan = await f.ApplyAsync(mapping);
        Assert.Equal("completed", plan.Status);
        await f.Db.GetCollection<BsonDocument>("llmgw_logical_models").DeleteOneAsync(new BsonDocument("_id", "source"));
        await f.Db.GetCollection<BsonDocument>("llmgw_model_offerings").DeleteOneAsync(new BsonDocument("_id", "source-offering"));
        var verified = await f.Engine.VerifyPlanAsync(plan.Id, Fixture.Tenant, plan.Revision);
        Assert.Equal("completed", verified.Status);
        Assert.Equal(1, verified.Coverage.Migrated);
        await f.Db.GetCollection<BsonDocument>("llmgw_logical_models").UpdateOneAsync(new BsonDocument("_id", "target"),
            Builders<BsonDocument>.Update.Set("Capabilities", new BsonArray { "text2img" }));
        var changed = await f.Engine.VerifyPlanAsync(plan.Id, Fixture.Tenant, verified.Revision);
        Assert.Equal("blocked", changed.Status);
        Assert.False(changed.Coverage.Verified);
    }
    [Fact]
    public async Task ScopedPreferenceRepairsRequireGlobalCompletionAndInvalidateOnNewOldReference()
    {
        await using var f = new Fixture();
        await f.SeedAsync("generation", Fixture.VisualCallers, openVisualTarget: true);
        await f.PutAsync("user_preferences", Preference("user-1", "pool_source"));
        await f.PutAsync("user_preferences", Preference("user-2", "OLD-ALIAS"));
        var firstMapping = await f.MappingAsync("map.preferences", "user-1", "VisualAgentPreferences.ModelId");
        Assert.Equal("source", firstMapping.Source.LogicalId);
        Assert.Equal("old-image", firstMapping.Source.PublicId);
        Assert.Contains("old-alias", firstMapping.Source.Aliases);
        Assert.Contains("pool-bridge", firstMapping.Source.PoolIds);
        var first = await f.ApplyAsync(firstMapping);
        Assert.Equal("blocked", first.Status);
        Assert.True(first.Coverage.Residual > 0);
        AssertPreference(await f.GetAsync("user_preferences", "user-1"), "user-1", "pool_target");
        AssertPreference(await f.GetAsync("user_preferences", "user-2"), "user-2", "OLD-ALIAS");

        var secondMapping = await f.MappingAsync("map.preferences", "user-2", "VisualAgentPreferences.ModelId");
        Assert.Equal("source", secondMapping.Source.LogicalId);
        Assert.Equal(firstMapping.Source.PoolIds, secondMapping.Source.PoolIds);
        var second = await f.ApplyAsync(secondMapping);
        Assert.Equal("completed", second.Status);
        Assert.True(second.Coverage.Verified);
        AssertPreference(await f.GetAsync("user_preferences", "user-2"), "user-2", "new-image");
        var firstVerified = await f.Engine.VerifyPlanAsync(first.Id, Fixture.Tenant, first.Revision);
        Assert.Equal("completed", firstVerified.Status);

        await f.PutAsync("user_preferences", Preference("user-3", "old-image"));
        var invalidated = await f.Engine.VerifyPlanAsync(second.Id, Fixture.Tenant, second.Revision);
        Assert.Equal("blocked", invalidated.Status);
        Assert.False(invalidated.Coverage.Verified);
        Assert.True(invalidated.Coverage.Residual > 0);
        AssertPreference(await f.GetAsync("user_preferences", "user-3"), "user-3", "old-image");
    }

    [Fact]
    public async Task DeletedArenaProviderRepairPreservesSlotAndNeverMatchesAnotherProviderByName()
    {
        await using var f = new Fixture();
        await f.SeedAsync("chat", ["prd-agent.arena.battle::chat"], openVisualTarget: false);
        // Both old providers/models are absent from the directory; the typed Arena purpose is chat.
        await f.PutAsync("arena_slots", new()
        {
            { "_id", "slot-a" },
            { "OwnerUserId", "owner-a" },
            { "PlatformId", "deleted-provider-a" },
            { "ModelId", "same-old-model" },
            { "Group", "group-a" },
            { "SortOrder", 17 } });
        await f.PutAsync("arena_slots", new()
        {
            { "_id", "slot-b" },
            { "OwnerUserId", "owner-b" },
            { "PlatformId", "deleted-provider-b" },
            { "ModelId", "same-old-model" } });
        var mapping = await f.MappingAsync("map.arena-slots", "slot-a", "ModelId");
        Assert.Equal("deleted-provider-a", mapping.Source.ProviderId);
        var plan = await f.ApplyAsync(mapping);
        Assert.Equal("completed", plan.Status);
        var repaired = await f.GetAsync("arena_slots", "slot-a");
        Assert.Equal("slot-a", repaired["_id"].AsString);
        Assert.Equal("owner-a", repaired["OwnerUserId"].AsString);
        Assert.Equal("group-a", repaired["Group"].AsString);
        Assert.Equal(17, repaired["SortOrder"].AsInt32);
        Assert.Equal("target", repaired["LogicalModelId"].AsString);
        Assert.Equal("logical-model", repaired["PlatformId"].AsString);
        Assert.Equal("new-image", repaired["ModelId"].AsString);
        var other = await f.GetAsync("arena_slots", "slot-b");
        Assert.Equal("deleted-provider-b", other["PlatformId"].AsString);
        Assert.Equal("same-old-model", other["ModelId"].AsString);
        Assert.False(other.Contains("LogicalModelId"));
    }

    [Fact]
    public async Task LabGenerationIsTypedFromDirectoryAndUnresolvablePurposeCannotBeGuessed()
    {
        await using var f = new Fixture();
        await f.SeedAsync("generation", Fixture.VisualCallers, openVisualTarget: true);
        await f.PutAsync("model_lab_experiments", new()
        {
            { "_id", "lab-image" },
            { "CreatedByUserId", "owner" },
            { "SelectedModels", new BsonArray { new BsonDocument
                    {
                        { "LogicalModelId", "source" },
                        { "PlatformId", "logical-model" },
                        { "ModelId", "old-image" } } } } });
        await f.PutAsync("model_lab_experiments", new()
        {
            { "_id", "lab-orphan" },
            { "CreatedByUserId", "owner" },
            { "SelectedModels", new BsonArray { new BsonDocument
                    {
                        { "PlatformId", "missing-provider" },
                        { "ModelId", "unresolved-old-model" } } } } });
        var usages = await f.Usages.ReadAsync(Fixture.Tenant, default);
        Assert.Equal("generation", usages.Single(x => x.RecordId == "lab-image").ModelType);
        Assert.Equal("unknown", usages.Single(x => x.RecordId == "lab-orphan").Status);
        var mapping = await f.MappingAsync("map.lab-experiments", "lab-image", "SelectedModels.0.ModelId");
        Assert.Equal("generation", mapping.ModelType);
        Assert.Equal("completed", (await f.ApplyAsync(mapping)).Status);
        var member = (await f.GetAsync("model_lab_experiments", "lab-image"))["SelectedModels"][0].AsBsonDocument;
        Assert.Equal("target", member["LogicalModelId"].AsString);
        await Assert.ThrowsAsync<ModelReferenceException>(() => f.MappingAsync("map.lab-experiments", "lab-orphan", "SelectedModels.0.ModelId"));
    }

    [Fact]
    public async Task ExplicitPurposeRepairsOwnerlessLabTupleThroughJournalAndPreservesHistory()
    {
        await using var f = new Fixture();
        await f.SeedAsync("generation", Fixture.VisualCallers, openVisualTarget: true);
        var tuple = new BsonDocument { { "PlatformId", "deleted-provider" }, { "ModelId", "missing-image" } };
        await f.PutAsync("model_lab_experiments", new() { { "_id", "orphan" }, { "OwnerAdminId", "deleted-user" },
            { "SelectedModels", new BsonArray { tuple } }, { "PromptText", "preserve prompt" } });
        await f.PutAsync("model_lab_runs", new() { { "_id", "history" }, { "ModelId", "missing-image" } });
        var usage = (await f.Usages.ReadAsync(Fixture.Tenant, default)).Single();
        Assert.True(usage.CanConfirmPurpose);
        Assert.Equal("unknown", usage.Status);
        var request = new ReferenceUsagePlanRequest("map.lab-experiments", "orphan", "SelectedModels.0.ModelId", "target", "explicit-purpose");
        await Assert.ThrowsAsync<ModelReferenceException>(() => f.Usages.BuildAsync(Fixture.Tenant, request, default));
        await Assert.ThrowsAsync<ModelReferenceException>(() => f.Usages.BuildAsync(Fixture.Tenant, request with { ConfirmedModelType = "chat", ExpectedUsageFingerprint = usage.Fingerprint }, default));
        await Assert.ThrowsAsync<ModelReferenceException>(() => f.Usages.BuildAsync(Fixture.Tenant,
            request with { ConfirmedModelType = "generation" }, default));
        await f.Db.GetCollection<BsonDocument>("model_lab_experiments").UpdateOneAsync(new BsonDocument("_id", "orphan"),
            Builders<BsonDocument>.Update.Set("SelectedModels.0.PlatformId", "changed-provider"));
        var stale = await Assert.ThrowsAsync<ModelReferenceException>(() => f.Usages.BuildAsync(Fixture.Tenant,
            request with { ConfirmedModelType = "generation", ExpectedUsageFingerprint = usage.Fingerprint }, default));
        Assert.Equal("REFERENCE_USAGE_CHANGED", stale.Code);
        await f.Db.GetCollection<BsonDocument>("model_lab_experiments").UpdateOneAsync(new BsonDocument("_id", "orphan"),
            Builders<BsonDocument>.Update.Set("SelectedModels.0.PlatformId", "deleted-provider"));
        var mapping = await f.Usages.BuildAsync(Fixture.Tenant, request with { ConfirmedModelType = "generation", ExpectedUsageFingerprint = usage.Fingerprint }, default);
        Assert.Equal("generation", mapping.ModelType);
        Assert.Equal("deleted-provider", mapping.Source.ProviderId);
        Assert.Equal("completed", (await f.ApplyAsync(mapping)).Status);
        var stored = await f.GetAsync("model_lab_experiments", "orphan");
        Assert.Equal("deleted-user", stored["OwnerAdminId"].AsString);
        Assert.Equal("preserve prompt", stored["PromptText"].AsString);
        Assert.Equal("target", stored["SelectedModels"][0]["LogicalModelId"].AsString);
        Assert.Equal("missing-image", (await f.GetAsync("model_lab_runs", "history"))["ModelId"].AsString);
    }

    [Fact]
    public async Task ExplicitPurposeCannotRepairMalformedIdentityOrOverrideKnownPurpose()
    {
        await using var f = new Fixture();
        await f.SeedAsync("generation", Fixture.VisualCallers, openVisualTarget: true);
        await f.PutAsync("model_lab_experiments", new() { { "_id", "malformed" }, { "SelectedModels", new BsonArray {
            new BsonDocument { { "PlatformId", 17 }, { "ModelId", "missing-image" } } } } });
        var usage = (await f.Usages.ReadAsync(Fixture.Tenant, default)).Single();
        Assert.False(usage.CanConfirmPurpose);
        await Assert.ThrowsAsync<ModelReferenceException>(() => f.Usages.BuildAsync(Fixture.Tenant,
            new("map.lab-experiments", "malformed", "SelectedModels.0.ModelId", "target", "reject-malformed", "generation"), default));
        await f.PutAsync("user_preferences", Preference("known", "old-image"));
        await Assert.ThrowsAsync<ModelReferenceException>(() => f.Usages.BuildAsync(Fixture.Tenant,
            new("map.preferences", "known", "VisualAgentPreferences.ModelId", "target", "reject-override", "chat"), default));
    }

    [Fact]
    public async Task LiteraryOnlyTargetCanRepairLiteraryWithoutGrantingVisualAccess()
    {
        await using var f = new Fixture();
        await f.SeedAsync("generation", ["literary-agent.illustration.text2img::generation", "literary-agent.illustration.img2img::generation"], openVisualTarget: false);
        await f.PutAsync("user_preferences", new()
        {
            { "_id", "literary-owner" },
            { "UserId", "literary-owner" },
            { "LiteraryAgentPreferences", new BsonDocument
                {
                    { "ImageModelId", "pool_source" },
                    { "ChatModelId", "unrelated-chat" } } },
            { "Theme", "dark" } });
        await f.PutAsync("user_preferences", Preference("visual-owner", "pool_source"));
        var literary = await f.ApplyAsync(await f.MappingAsync("map.preferences", "literary-owner", "LiteraryAgentPreferences.ImageModelId"));
        var stored = await f.GetAsync("user_preferences", "literary-owner");
        Assert.Equal("pool_target", stored["LiteraryAgentPreferences"]["ImageModelId"].AsString);
        Assert.Equal("unrelated-chat", stored["LiteraryAgentPreferences"]["ChatModelId"].AsString);
        Assert.Equal("literary-owner", stored["UserId"].AsString);
        Assert.Equal("dark", stored["Theme"].AsString);
        Assert.DoesNotContain(literary.Coverage.Consumers, x => x.Key == "target.authorization-capabilities" && (x.Blocked > 0 || x.Unknown > 0));
        var visual = await f.ApplyAsync(await f.MappingAsync("map.preferences", "visual-owner", "VisualAgentPreferences.ModelId"));
        Assert.Equal("blocked", visual.Status);
        AssertPreference(await f.GetAsync("user_preferences", "visual-owner"), "visual-owner", "pool_source");
    }

    private static BsonDocument Preference(string owner, string model) => new()
    {
        { "_id", owner },
        { "UserId", owner },
        { "VisualAgentPreferences", new BsonDocument {
                { "ModelAuto", false },
                { "ModelId", model },
                { "GenerationType", "vision" } } },
        { "Theme", "dark" }
    };
    private static void AssertPreference(BsonDocument document, string owner, string model)
    {
        Assert.Equal(owner, document["UserId"].AsString);
        Assert.Equal(model, document["VisualAgentPreferences"]["ModelId"].AsString);
        Assert.False(document["VisualAgentPreferences"]["ModelAuto"].AsBoolean);
        Assert.Equal("vision", document["VisualAgentPreferences"]["GenerationType"].AsString);
        Assert.Equal("dark", document["Theme"].AsString);
    }

    // This stub is only valid inside these random, loopback-only test databases; never a release proof.
    private sealed class TestDatabaseRuntime(string database) : IRuntimeModelReferenceSnapshotProvider
    {
        public Task<RuntimeModelReferenceSnapshot> ReadAsync(ReferenceMigrationMapping mapping, CancellationToken ct)
        {
            Assert.StartsWith("model_reference_business_test_", database);
            Assert.Equal(Fixture.Tenant, mapping.TenantId);
            return Task.FromResult(new RuntimeModelReferenceSnapshot(true, []));
        }
    }
    private sealed class Fixture : IAsyncDisposable
    {
        public const string Tenant = "tenant_map_internal";
        public static readonly string[] VisualCallers = ["visual-agent.image.text2img::generation", "visual-agent.image.img2img::generation", "visual-agent.image.vision::generation"];
        private readonly MongoClient _client;
        private readonly string _name = "model_reference_business_test_" + Guid.NewGuid().ToString("N");
        public IMongoDatabase Db { get; }
        public ModelReferenceEngine Engine { get; }
        public ModelReferenceUsageCatalog Usages { get; }
        public Fixture()
        {
            var connection = Environment.GetEnvironmentVariable("MODEL_REFERENCE_TEST_MONGO_URI") ?? "mongodb://127.0.0.1:27912";
            if (!Uri.TryCreate(connection, UriKind.Absolute, out var uri) || uri.Scheme != "mongodb" || uri.Port is < 1 or > 65535
            || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.AbsolutePath is not ("" or "/")
            || !(uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || IPAddress.TryParse(uri.Host, out var address) && IPAddress.IsLoopback(address)))
            throw new InvalidOperationException("业务迁移集成测试仅允许无凭据的显式本机 Mongo 端口。");
            var settings = MongoClientSettings.FromConnectionString(connection);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            _client = new MongoClient(settings);
            Db = _client.GetDatabase(_name);
            var store = new MongoModelReferenceStore(Db, Db, Tenant);
            var catalog = new ModelReferenceCatalog(Db, Db, Tenant);
            Usages = new(Db, store, catalog, Tenant);
            Engine = new(store, Tenant, new TestDatabaseRuntime(_name), catalog);
        }
        public Task PutAsync(string collection, BsonDocument document) => Db.GetCollection<BsonDocument>(collection).InsertOneAsync(document);
        public Task<BsonDocument> GetAsync(string collection, string id) => Db.GetCollection<BsonDocument>(collection).Find(new BsonDocument("_id", id)).SingleAsync();
        public Task<ReferenceMigrationMapping> MappingAsync(string consumer, string id, string path)
        => Usages.BuildAsync(Tenant, new(consumer, id, path, "target", Guid.NewGuid().ToString("N")), default);
        public async Task<ReferenceMigrationPlan> ApplyAsync(ReferenceMigrationMapping mapping)
        {
            var plan = await Engine.PlanAsync(mapping, "test-admin", Guid.NewGuid().ToString("N"));
            return await Engine.ApplyAsync(plan.Id, Tenant, plan.Revision);
        }
        public async Task SeedAsync(string type, string[] callers, bool openVisualTarget)
        {
            var caps = type == "chat" ? new[] { "chat" } : new[] { "image_generation", "text2img", "img2img", "vision_generation" };
            foreach (var id in new[] { "source", "target" })
            {
                await PutAsync("llmgw_logical_models", new()
                {
                    { "_id", id },
                    { "TenantId", Tenant },
                    { "Enabled", true },
                    { "PublicId", id == "source" ? "old-image" : "new-image" },
                    { "ModelType", type },
                    { "Capabilities", new BsonArray(caps) },
                    { "AllowedAppCallerCodes", new BsonArray(callers) },
                    { "Aliases", id == "source" ? new BsonArray { "old-alias" } : new BsonArray() },
                    { "MigratedFromPoolIds", id == "source" ? new BsonArray { "pool-bridge" } : new BsonArray() } });
                await PutAsync("llmgw_models", new()
                {
                    { "_id", id + "-model" },
                    { "TenantId", Tenant },
                    { "PlatformId", "provider" },
                    { "ModelName", id + "-wire" },
                    { "Enabled", true },
                    { "Capabilities", new BsonArray(caps.Select(x => new BsonDocument
                        {
                            { "Type", x },
                            { "Value", true } })) } });
                await PutAsync("llmgw_model_offerings", new()
                {
                    { "_id", id + "-offering" },
                    { "TenantId", Tenant },
                    { "LogicalModelId", id },
                    { "TargetKind", "model" },
                    { "TargetId", id + "-model" },
                    { "Enabled", true } });
            }
            await PutAsync("llmgw_platforms", new()
            {
                { "_id", "provider" },
                { "TenantId", Tenant },
                { "Enabled", true } });
            await PutAsync("appsettings", new()
            {
                { "_id", "global" },
                { "VisualModelPolicy", new BsonDocument
                    {
                        { "DefaultModelId", openVisualTarget ? "new-image" : "unrelated" },
                        { "Revision", 1 },
                        { "Models", new BsonArray { new BsonDocument("ModelId", openVisualTarget ? "new-image" : "unrelated") } } } } });
        }
        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_name);
    }
}
