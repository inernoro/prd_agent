using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using PrdAgent.LlmGw.ModelReferences;
using Xunit;

namespace PrdAgent.Tests;

public sealed class ModelReferenceEngineTests
{
    private static ReferenceMigrationMapping Mapping(string tenant = "internal") => new()
    {
        TenantId = tenant,
        Source = new() { LogicalId = "old-logical", PublicId = "old-fixed", Aliases = ["old-alias"], PoolIds = ["old-pool"], ProviderId = "old-provider", PhysicalModelId = "old-physical", UpstreamModelId = "old-upstream", OfferingId = "old-wire" },
        Target = new() { LogicalId = "new-logical", PublicId = "new-fixed", ProviderId = "official", PhysicalModelId = "new-physical", UpstreamModelId = "new-upstream", OfferingId = "new-wire" },
    };
    private sealed class Runtime : IRuntimeModelReferenceSnapshotProvider
    {
        public Task<RuntimeModelReferenceSnapshot> ReadAsync(ReferenceMigrationMapping m, CancellationToken ct) => Task.FromResult(new RuntimeModelReferenceSnapshot(true, []));
    }
    private sealed class Validator : IModelReferenceTargetValidator
    {
        public bool Deny { get; set; }
        public bool Fail { get; set; }
        public int FindingsSeen { get; private set; }
        public Task<IReadOnlyList<string>> ValidateAsync(ReferenceMigrationMapping m, IReadOnlyList<string> keys, CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);
        public Task<IReadOnlyList<string>> ValidateFindingsAsync(ReferenceMigrationMapping m, IReadOnlyList<ReferenceFinding> findings, CancellationToken ct)
        {
            FindingsSeen = findings.Count;
            if (Fail) throw new InvalidOperationException("catalog unavailable");
            return Task.FromResult<IReadOnlyList<string>>(Deny ? ["target disabled"] : []);
        }
    }
    private static ModelReferenceEngine Engine(MemoryStore store) => new(store, "internal", new Runtime(), new Validator());
    [Fact]
    public async Task RegistryChangeWithdrawsOldSuccessWithoutReauthorizingOldChanges()
    {
        var store = new MemoryStore();
        store.Add("user_preferences", "{_id:'owner',VisualAgentPreferences:{ModelId:'old-fixed',ModelAuto:false}}");
        var engine = Engine(store);
        var plan = await engine.PlanAsync(Mapping(), "admin");
        plan = await engine.ApplyAsync(plan.Id, "internal", plan.Revision);
        Assert.True(plan.Coverage.Verified);
        store.Plans[plan.Id].Coverage.RegistryHash = "previous-registry";
        var checkedPlan = await engine.VerifyPlanAsync(plan.Id, "internal", plan.Revision);
        Assert.Equal("blocked", checkedPlan.Status);
        Assert.False(checkedPlan.Coverage.Verified);
        Assert.Null(checkedPlan.Coverage.ValidUntil);
        Assert.Equal("previous-registry", checkedPlan.Coverage.RegistryHash);
        Assert.Contains(checkedPlan.Coverage.Consumers, x => x.Key == "registry.changed" && x.Unknown == 1);
        var denied = await Assert.ThrowsAsync<ModelReferenceException>(() => engine.ApplyAsync(plan.Id, "internal", checkedPlan.Revision));
        Assert.Equal("REFERENCE_REGISTRY_CHANGED", denied.Code);
    }
    private sealed class MemoryStore : IModelReferenceStore
    {
        public Dictionary<string, List<BsonDocument>> Data { get; } = new();
        public Dictionary<string, ReferenceMigrationPlan> Plans { get; } = new();
        public List<string> Reads { get; } = [];
        public bool ConflictNext { get; set; }
        public bool FailJournal { get; set; }
        public int Writes { get; private set; }
        public BsonDocument Add(string collection, string json)
        {
            var doc = BsonDocument.Parse(json); if (!Data.TryGetValue(collection, out var docs)) Data[collection] = docs = [];
            docs.Add(doc); return doc;
        }
        private static ReferenceMigrationPlan Clone(ReferenceMigrationPlan plan) => BsonSerializer.Deserialize<ReferenceMigrationPlan>(plan.ToBson());
        private static BsonValue Project(BsonValue value, string prefix, string[] paths)
        {
            if (value is BsonArray array) return new BsonArray(array.Select(x => Project(x, prefix, paths)));
            if (value is not BsonDocument doc) return value.DeepClone();
            var result = new BsonDocument();
            foreach (var field in doc)
            {
                var path = prefix.Length == 0 ? field.Name : prefix + "." + field.Name;
                if (paths.Contains(path)) result[field.Name] = field.Value.DeepClone();
                else if (paths.Any(p => p.StartsWith(path + ".", StringComparison.Ordinal))) result[field.Name] = Project(field.Value, path, paths);
            }
            return result;
        }
        public Task<IReadOnlyList<BsonDocument>> ReadAsync(ReferenceCollection c, string tenant, CancellationToken ct)
        {
            Reads.Add(c.Collection);
            return Task.FromResult<IReadOnlyList<BsonDocument>>((Data.GetValueOrDefault(c.Collection) ?? []).Where(x => c.Database == "map" || x.GetValue("TenantId", "") == tenant)
                .Select(x => Project(x, "", c.ProjectionPaths.Concat(ModelReferenceRegistry.MetadataPaths).ToArray()).AsBsonDocument).ToArray());
        }
        private static IEnumerable<string> Paths(BsonValue value, string prefix = "")
        {
            if (value is BsonArray a) { foreach (var v in a) foreach (var p in Paths(v, prefix + "[]")) yield return p; }
            else if (value is BsonDocument d) foreach (var e in d)
            {
                var path = prefix.Length == 0 ? e.Name : prefix + "." + e.Name;
                if (ModelReferenceRegistry.IsSelectionName(e.Name)) yield return path;
                foreach (var p in Paths(e.Value, path)) yield return p;
            }
        }
        public Task<IReadOnlyList<string>> SelectionPathsAsync(ReferenceCollection c, string tenant, CancellationToken ct)
            => Task.FromResult<IReadOnlyList<string>>((Data.GetValueOrDefault(c.Collection) ?? []).Where(x => c.Database == "map" || x.GetValue("TenantId", "") == tenant).SelectMany(x => Paths(x)).Distinct().ToArray());
        private BsonDocument? Doc(ReferenceDocumentChange c, string tenant) => Data.GetValueOrDefault(c.Collection)?.FirstOrDefault(x => x.GetValue("_id", "") == c.RecordId && (c.Database == "map" || x.GetValue("TenantId", "") == tenant));
        public static void Set(BsonDocument doc, string path, BsonValue value)
        {
            var parts = path.Split('.'); BsonValue node = doc;
            for (var i = 0; i < parts.Length - 1; i++)
            {
                if (node is BsonDocument d) { if (!d.Contains(parts[i])) d[parts[i]] = new BsonDocument(); node = d[parts[i]]; }
                else node = node.AsBsonArray[int.Parse(parts[i])];
            }
            if (node is BsonDocument last) last[parts[^1]] = value.DeepClone(); else node.AsBsonArray[int.Parse(parts[^1])] = value.DeepClone();
        }
        public Task<bool> CompareAndSwapAsync(ReferenceDocumentChange c, string tenant, CancellationToken ct)
        {
            if (ConflictNext) { ConflictNext = false; return Task.FromResult(false); }
            var d = Doc(c, tenant);
            if (d is null || c.Conditions.Any(x => ModelReferenceAnalysis.TryGet(d, x.Path, out var v) != x.Existed || x.Existed && v != x.Before)
                || c.ArrayLengths.Any(x => !ModelReferenceAnalysis.TryGet(d, x.Key, out var a) || a is not BsonArray b || b.Count != x.Value)) return Task.FromResult(false);
            foreach (var f in c.Fields) Set(d, f.Path, f.After);
            Writes++; return Task.FromResult(true);
        }
        public Task<bool> IsAppliedAsync(ReferenceDocumentChange c, string tenant, CancellationToken ct)
        {
            var d = Doc(c, tenant); return Task.FromResult(d is not null && c.Fields.All(x => ModelReferenceAnalysis.TryGet(d, x.Path, out var v) && v == x.After));
        }
        public Task InsertPlanAsync(ReferenceMigrationPlan plan, CancellationToken ct)
        {
            if (FailJournal) throw new InvalidOperationException("journal unavailable");
            Plans.Add(plan.Id, Clone(plan)); return Task.CompletedTask;
        }
        public Task<ReferenceMigrationPlan?> ReadPlanAsync(string id, string tenant, CancellationToken ct) => Task.FromResult(Plans.TryGetValue(id, out var p) && p.TenantId == tenant ? Clone(p) : null);
        public Task<bool> SavePlanAsync(ReferenceMigrationPlan plan, long revision, CancellationToken ct)
        {
            if (FailJournal) throw new InvalidOperationException("journal unavailable");
            if (!Plans.TryGetValue(plan.Id, out var p) || p.Revision != revision) return Task.FromResult(false);
            Plans[plan.Id] = Clone(plan); return Task.FromResult(true);
        }
    }
    [Fact]
    public async Task CompleteFixtureMigratesAllImplementedConsumersAndPreservesHistoryOwnersAndSecrets()
    {
        var s = new MemoryStore();
        s.Add("llmgw_model_offerings", "{_id:'old-wire',TenantId:'internal',Enabled:true,LogicalModelId:'old-logical',TargetId:'old-physical'}");
        var slot = s.Add("arena_slots", "{_id:'slot',LogicalModelId:'old-logical',PlatformId:'old-provider',ModelId:'old-upstream',Enabled:false,Group:'dj',SortOrder:3}");
        foreach (var pair in new[] { ("model_lab_experiments", "SelectedModels"), ("model_lab_model_sets", "Models"), ("model_lab_groups", "Models") })
            s.Add(pair.Item1, "{_id:'" + pair.Item1 + "',OwnerUserId:'owner'," + pair.Item2 + ":[{LogicalModelId:'old-logical',PlatformId:'old-provider',ModelId:'old-upstream',DisplayName:'keep'}]}");
        var prefs = s.Add("user_preferences", "{_id:'prefs',UserId:'owner',VisualAgentPreferences:{ModelAuto:false,ModelId:'pool_old-logical',Theme:'keep'},LiteraryAgentPreferences:{ImageModelId:'old-pool',ChatModelId:'old-fixed'}}");
        var policy = s.Add("appsettings", "{_id:'global',VisualModelPolicy:{Revision:3,DefaultModelId:'old-fixed',Models:[{ModelId:'old-fixed',DisplayName:'keep'}]}}");
        var key = s.Add("agent_api_keys", "{_id:'key',OwnerUserId:'owner',ApiKeyEncrypted:'secret-never-project',OpenApiChatModels:['other','old-fixed','new-fixed'],OpenApiImageModels:['old-alias'],McpLiteraryImageModelMode:1,McpLiteraryImageModelPublicId:'old-fixed'}");
        var workflow = s.Add("workflows", "{_id:'workflow',CreatedBy:'owner',Nodes:[{NodeId:'n',NodeType:'claude-sdk',Config:{model:'old-fixed',prompt:'old-fixed should stay',apiKey:'do-not-read'}}]}");
        s.Add("video_projects", "{_id:'video',DefaultVideoModel:'old-fixed'}");
        s.Add("chat_agent_sessions", "{_id:'session',UserId:'owner',Model:'old-fixed'}");
        var history = s.Add("arena_battles", "{_id:'history',Responses:[{ModelId:'old-fixed'}]}").DeepClone();
        var engine = Engine(s); var plan = await engine.PlanAsync(Mapping(), "admin");
        Assert.True(plan.Coverage.CanComplete); Assert.Equal(10, plan.Changes.Count);
        Assert.DoesNotContain("secret-never-project", plan.ToJson()); Assert.DoesNotContain("do-not-read", plan.ToJson());
        var applied = await engine.ApplyAsync(plan.Id, "internal", plan.Revision);
        Assert.Equal("completed", applied.Status); Assert.True(applied.Coverage.Verified); Assert.Equal(0, applied.Coverage.Residual);
        Assert.Equal("new-logical", slot["LogicalModelId"]); Assert.False(slot["Enabled"].AsBoolean); Assert.Equal("dj", slot["Group"]);
        Assert.Equal("pool_new-logical", prefs["VisualAgentPreferences"]["ModelId"]); Assert.Equal("keep", prefs["VisualAgentPreferences"]["Theme"]);
        Assert.Equal(4, policy["VisualModelPolicy"]["Revision"].AsInt64);
        Assert.Equal(new BsonArray { "other", "new-fixed" }, key["OpenApiChatModels"]); Assert.Equal("secret-never-project", key["ApiKeyEncrypted"]);
        Assert.Equal("old-fixed should stay", workflow["Nodes"][0]["Config"]["prompt"]);
        Assert.Equal(history, s.Data["arena_battles"][0]); Assert.DoesNotContain("arena_battles", s.Reads);
        Assert.True((await engine.VerifyAsync(plan.Id, "internal")).Verified);
        Assert.Equal(10, s.Writes);
        var latest = await engine.GetAsync(plan.Id, "internal");
        var replay = await engine.ApplyAsync(plan.Id, "internal", latest.Revision); Assert.Equal("completed", replay.Status); Assert.Equal(10, s.Writes);
    }
    [Fact]
    public async Task DifferentNonemptyLogicalIdNeverMatchesLegacyPairOrRecreatedPublicId()
    {
        var s = new MemoryStore(); s.Add("arena_slots", "{_id:'slot',LogicalModelId:'another-id',PlatformId:'logical-model',ModelId:'old-fixed'}");
        s.Add("model_lab_groups", "{_id:'g',Models:[{PlatformId:'old-provider',ModelId:'other'},{PlatformId:'other',ModelId:'old-upstream'}]}");
        var p = await Engine(s).PlanAsync(Mapping(), "admin"); Assert.Empty(p.Changes); Assert.Equal(0, p.Coverage.Affected);
    }
    [Fact]
    public async Task ExplicitLegacyLogicalAndPhysicalTupleAreMigrated()
    {
        var s = new MemoryStore(); s.Add("arena_slots", "{_id:'a',PlatformId:'logical-model',ModelId:'old-fixed'}");
        s.Add("model_lab_groups", "{_id:'g',Models:[{LogicalModelId:null,PlatformId:'old-provider',ModelId:'old-upstream'}]}");
        var p = await Engine(s).PlanAsync(Mapping(), "admin"); Assert.Equal(2, p.Changes.Count);
    }
    [Fact]
    public async Task UnknownSelectionPathAndWrongSchemaFailClosed()
    {
        var s = new MemoryStore(); s.Add("user_preferences", "{_id:'u',FutureAgent:{ModelId:'old-fixed'},VisualAgentPreferences:{ModelId:{unexpected:'bad'}}}");
        var e = Engine(s); var p = await e.PlanAsync(Mapping(), "admin"); Assert.False(p.Coverage.CanComplete); Assert.True(p.Coverage.Unknown >= 2);
        Assert.Equal("blocked", (await e.ApplyAsync(p.Id, "internal", p.Revision)).Status); Assert.Equal(0, s.Writes);
    }
    [Theory]
    [InlineData("speech_settings", "{_id:'s',Profiles:[{ModelPoolId:'old-fixed',Model:'old-upstream',OfferingId:'old-wire'}]}")]
    [InlineData("infra_agent_runtime_profiles", "{_id:'s',Model:'old-fixed'}")]
    [InlineData("video_gen_runs", "{_id:'s',DirectVideoModel:'old-fixed',DirectVideoJobId:'accepted-job'}")]
    [InlineData("llmgw_model_offerings", "{_id:'another-wire',TenantId:'internal',Enabled:true,LogicalModelId:'other-fixed-logical',TargetId:'old-physical'}")]
    public async Task UnsafeSpecializedBindingsAreExplicitlyBlocked(string collection, string json)
    {
        var s = new MemoryStore(); s.Add(collection, json); var p = await Engine(s).PlanAsync(Mapping(), "admin"); Assert.False(p.Coverage.CanComplete); Assert.True(p.Coverage.Blocked > 0); Assert.Empty(p.Changes);
    }
    [Fact]
    public async Task MissingRuntimeSnapshotOrValidatorCannotBeClaimedComplete()
    {
        var s = new MemoryStore(); s.Add("arena_slots", "{_id:'a',LogicalModelId:'old-logical'}");
        var p = await new ModelReferenceEngine(s, "internal").PlanAsync(Mapping(), "admin"); Assert.False(p.Coverage.CanComplete); Assert.Equal(1, p.Coverage.Unknown); Assert.Equal(1, p.Coverage.Blocked);
    }
    [Fact]
    public async Task ExternalTenantNeverReadsMapOrAnotherGatewayTenant()
    {
        var s = new MemoryStore(); s.Add("arena_slots", "{_id:'a',LogicalModelId:'old-logical'}"); s.Add("llmgw_logical_models", "{_id:'old-logical',TenantId:'other',IsDefaultForType:true}");
        var p = await Engine(s).PlanAsync(Mapping("external"), "admin"); Assert.DoesNotContain("arena_slots", s.Reads); Assert.Empty(p.Changes); Assert.Equal(0, p.Coverage.Affected);
    }
    [Fact]
    public async Task ConcurrentEditAndNewReferenceNeverProduceSuccess()
    {
        var s = new MemoryStore(); var doc = s.Add("arena_slots", "{_id:'a',LogicalModelId:'old-logical',UpdatedAt:1}"); var e = Engine(s); var p = await e.PlanAsync(Mapping(), "admin");
        doc["UpdatedAt"] = 2;
        var conflict = await e.ApplyAsync(p.Id, "internal", p.Revision); Assert.Equal("conflict", conflict.Status); Assert.Equal("old-logical", doc["LogicalModelId"]); Assert.Equal(0, s.Writes);
        var next = await e.PlanAsync(Mapping(), "admin"); s.Add("arena_slots", "{_id:'b',LogicalModelId:'old-logical'}");
        Assert.Equal("conflict", (await e.ApplyAsync(next.Id, "internal", next.Revision)).Status); Assert.Equal(0, s.Writes);
    }
    [Fact]
    public async Task CrashAfterConfigurationWriteResumesSameIntentWithoutOverwriting()
    {
        var s = new MemoryStore(); var doc = s.Add("arena_slots", "{_id:'a',LogicalModelId:'old-logical'}"); var e = Engine(s); var p = await e.PlanAsync(Mapping(), "admin");
        // Durable intent remains pending when an acknowledgement is lost after the conditional write.
        foreach (var f in p.Changes.Single().Fields) MemoryStore.Set(doc, f.Path, f.After);
        var resumed = await e.ApplyAsync(p.Id, "internal", p.Revision); Assert.Equal("completed", resumed.Status); Assert.Equal(0, s.Writes);
    }
    [Fact]
    public async Task JournalFailurePrecedesAllBusinessWrites()
    {
        var s = new MemoryStore { FailJournal = true }; s.Add("arena_slots", "{_id:'a',LogicalModelId:'old-logical'}");
        await Assert.ThrowsAsync<InvalidOperationException>(() => Engine(s).PlanAsync(Mapping(), "admin")); Assert.Equal(0, s.Writes);
    }
    [Fact]
    public async Task WorkflowVariableAndUnknownRuntimeCannotBeSilentlySkipped()
    {
        var s = new MemoryStore(); s.Add("workflows", "{_id:'w',Nodes:[{NodeType:'claude-sdk',Config:{model:'{{runtimeModel}}'}},{NodeType:'future-sdk',Config:{model:'old-fixed'}}]}");
        var p = await Engine(s).PlanAsync(Mapping(), "admin"); Assert.Equal(1, p.Coverage.Unknown); Assert.Equal(1, p.Coverage.Blocked);
    }
    [Fact]
    public void MongoProjectionAndCasContainNoSecretFieldsAndBindArrayPositionAndTenant()
    {
        var key = ModelReferenceRegistry.Collections.Single(x => x.Collection == "agent_api_keys"); var projection = MongoModelReferenceStore.SafeProjection(key).ToJson();
        Assert.DoesNotContain("ApiKey", projection); Assert.Contains("OpenApiChatModels", projection);
        var c = new ReferenceDocumentChange { Database = "gateway", RecordId = "id", Conditions = [new() { Path = "Models.0.ModelId", Existed = true, Before = "old" }], ArrayLengths = new() { ["Models"] = 2 } };
        var filter = MongoModelReferenceStore.CompareFilter(c, "tenant").Render(new MongoDB.Driver.RenderArgs<BsonDocument>(BsonSerializer.SerializerRegistry.GetSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry)).ToJson();
        Assert.Contains("TenantId", filter); Assert.Contains("Models.0.ModelId", filter); Assert.Contains("$size", filter);
    }

    [Fact]
    public async Task RequestIdIsTenantActorScopedAndRejectsAnotherMapping()
    {
        var store = new MemoryStore(); var engine = Engine(store); var request = Guid.NewGuid().ToString();
        var plan = await engine.PlanAsync(Mapping(), "admin", request);
        Assert.Equal(plan.Id, (await engine.PlanAsync(Mapping(), "admin", request)).Id);
        Assert.Equal(plan.Id, (await engine.GetByRequestAsync("internal", "admin", request))!.Id);
        Assert.Null(await engine.GetByRequestAsync("internal", "another", request));
        var other = Mapping(); other.Target.PublicId = "different";
        var ex = await Assert.ThrowsAsync<ModelReferenceException>(() => engine.PlanAsync(other, "admin", request));
        Assert.Equal("REFERENCE_REQUEST_MAPPING_CHANGED", ex.Code);
    }
    [Fact]
    public async Task VerifyPersistsFreshnessAndInvalidatesCompletedWhenNewOldReferenceAppears()
    {
        var store = new MemoryStore(); var engine = Engine(store); var p = await engine.PlanAsync(Mapping(), "admin");
        var done = await engine.VerifyPlanAsync(p.Id, "internal", p.Revision);
        Assert.True(done.Coverage.Verified); Assert.NotNull(done.Coverage.VerifiedAt); Assert.Equal(TimeSpan.FromMinutes(10), done.Coverage.ValidUntil - done.Coverage.VerifiedAt);
        store.Add("arena_slots", "{_id:'later',LogicalModelId:'old-logical'}");
        var invalid = await engine.VerifyPlanAsync(p.Id, "internal", done.Revision);
        Assert.Equal("blocked", invalid.Status); Assert.False(invalid.Coverage.Verified); Assert.Null(invalid.Coverage.ValidUntil);
        Assert.False((await engine.GetAsync(p.Id, "internal")).Coverage.Verified);
    }
    [Fact]
    public async Task MigratedFromPoolIdsUsesRealCanonicalSchemaAndStableReferencesDoNotMigrate()
    {
        var store = new MemoryStore();
        store.Add("llmgw_logical_models", "{_id:'old-logical',TenantId:'internal',PublicId:'old-fixed',Aliases:['real-alias'],MigratedFromPoolIds:['real-legacy-pool']}");
        store.Add("user_preferences", "{_id:'u',VisualAgentPreferences:{ModelId:'real-legacy-pool'}}");
        var plan = await Engine(store).PlanAsync(Mapping(), "admin");
        Assert.Contains("real-legacy-pool", plan.Mapping.Source.PoolIds); Assert.Contains("real-alias", plan.Mapping.Source.Aliases);
        Assert.Contains(plan.Changes.Single().Fields, x => x.Path == "VisualAgentPreferences.ModelId" && x.After == new BsonString("new-logical"));
        var stable = Mapping(); stable.Target.LogicalId = stable.Source.LogicalId; stable.Target.PublicId = stable.Source.PublicId;
        store.Data["user_preferences"][0]["VisualAgentPreferences"]["ModelId"] = "pool_old-logical";
        var unchanged = await Engine(store).InspectAsync(stable); Assert.Equal(0, unchanged.Affected);
    }
    [Fact]
    public async Task StableWireIsSwitchOwnedButOtherEnabledFixedLogicalStillBlocksUpgrade()
    {
        var store = new MemoryStore(); var m = Mapping(); m.Target.LogicalId = m.Source.LogicalId; m.Target.PublicId = m.Source.PublicId;
        store.Add("llmgw_model_offerings", "{_id:'old-wire',TenantId:'internal',Enabled:true,LogicalModelId:'old-logical',TargetId:'old-physical'}");
        Assert.True((await Engine(store).InspectAsync(m)).CanComplete);
        store.Add("llmgw_model_offerings", "{_id:'fixed-route',TenantId:'internal',Enabled:true,LogicalModelId:'different-fixed-logical',TargetId:'old-physical'}");
        var result = await Engine(store).InspectAsync(m); Assert.Equal(1, result.Blocked); Assert.False(result.CanComplete);
    }
    [Fact]
    public async Task DeleteIgnoresOwnWireButNeverIgnoresDefaultRole()
    {
        var store = new MemoryStore(); store.Add("llmgw_model_offerings", "{_id:'old-wire',TenantId:'internal',Enabled:true,LogicalModelId:'old-logical',TargetId:'old-physical'}");
        var m = Mapping(); m.Target = new(); var e = Engine(store); Assert.Equal(0, (await e.FindDeleteBlockersAsync(m)).Blocked);
        store.Add("llmgw_logical_models", "{_id:'old-logical',TenantId:'internal',PublicId:'old-fixed',IsDefaultForType:true}");
        Assert.True((await e.FindDeleteBlockersAsync(m)).Blocked > 0);
    }
    [Fact]
    public async Task ScopedOrphanRepairCannotChangeAnotherUsageOrAnotherPurpose()
    {
        var store = new MemoryStore(); var doc = store.Add("user_preferences", "{_id:'owner',VisualAgentPreferences:{ModelId:'orphan'},LiteraryAgentPreferences:{ChatModelId:'orphan'}}");
        var m = Mapping(); m.Source = new() { PublicId = "orphan" }; m.ModelType = "generation";
        m.ScopeConsumerKey = "map.preferences"; m.ScopeRecordId = "owner"; m.ScopePath = "VisualAgentPreferences.ModelId";
        var p = await Engine(store).PlanAsync(m, "admin"); var done = await Engine(store).ApplyAsync(p.Id, "internal", p.Revision);
        Assert.Equal("blocked", done.Status); Assert.False(done.Coverage.Verified);
        Assert.Contains(done.Coverage.Consumers, x => x.Key == "scope.global-old-identity" && x.Residual > 0);
        Assert.Equal("new-fixed", doc["VisualAgentPreferences"]["ModelId"]); Assert.Equal("orphan", doc["LiteraryAgentPreferences"]["ChatModelId"]);
        doc["LiteraryAgentPreferences"]["ChatModelId"] = "new-fixed";
        var verified = await Engine(store).VerifyPlanAsync(p.Id, "internal", done.Revision); Assert.True(verified.Coverage.Verified);
        store.Add("user_preferences", "{_id:'another-owner',VisualAgentPreferences:{ModelId:'orphan'}}");
        var invalid = await Engine(store).VerifyPlanAsync(p.Id, "internal", verified.Revision); Assert.False(invalid.Coverage.Verified);
    }
    [Fact]
    public void RuntimeIdentityKindsNeverMatchSameTextAcrossNamespaces()
    {
        var identity = new ReferenceIdentity { LogicalId = "same", PublicId = "public", ProviderId = "p", UpstreamModelId = "upstream" };
        Assert.False(MongoRuntimeModelReferenceSnapshotProvider.Matches(identity, new("c", "p", "public-id", "same")));
        Assert.False(MongoRuntimeModelReferenceSnapshotProvider.Matches(identity, new("c", "p", "physical-pair", "upstream", "other")));
        Assert.True(MongoRuntimeModelReferenceSnapshotProvider.Matches(identity, new("c", "p", "physical-pair", "upstream", "p")));
    }

    [Fact]
    public async Task TargetValidationKeepsOriginalPurposeAfterMigrationAndInvalidatesOldGreen()
    {
        var store = new MemoryStore(); store.Add("arena_slots", "{_id:'a',LogicalModelId:'old-logical'}");
        var target = new Validator(); var engine = new ModelReferenceEngine(store, "internal", new Runtime(), target);
        var plan = await engine.PlanAsync(Mapping(), "admin"); var done = await engine.ApplyAsync(plan.Id, "internal", plan.Revision);
        Assert.True(done.Coverage.Verified); Assert.True(target.FindingsSeen > 0);
        target.Deny = true; var disabled = await engine.VerifyPlanAsync(plan.Id, "internal", done.Revision);
        Assert.False(disabled.Coverage.Verified); Assert.False(disabled.Coverage.CanComplete); Assert.True(target.FindingsSeen > 0);
        target.Fail = true; var unknown = await engine.VerifyPlanAsync(plan.Id, "internal", disabled.Revision);
        Assert.True(unknown.Coverage.Unknown > 0); Assert.Null(unknown.Coverage.ValidUntil); Assert.False((await engine.GetAsync(plan.Id, "internal")).Coverage.Verified);
    }

    [Theory]
    [InlineData("Completed")]
    [InlineData("Failed")]
    [InlineData("Cancelled")]
    public async Task TerminalVideoActualWireAndDeletedChatAreNeverMigratedOrPermanentBlockers(string status)
    {
        var store = new MemoryStore(); store.Add("video_gen_runs", "{_id:'history',Status:'" + status + "',DirectVideoModel:'old-fixed',DirectVideoJobId:'accepted-job'}");
        store.Add("chat_agent_sessions", "{_id:'deleted',Deleted:true,Model:'old-fixed'}");
        var plan = await Engine(store).PlanAsync(Mapping(), "admin"); Assert.True(plan.Coverage.CanComplete); Assert.Empty(plan.Changes); Assert.Equal(0, plan.Coverage.Residual);
    }

    [Fact]
    public async Task PublicIdentityUsesRuntimeNormalizationButAllOpaqueIdsRemainExact()
    {
        var store = new MemoryStore();
        var preferences = store.Add("user_preferences", "{_id:'u',VisualAgentPreferences:{ModelId:' OLD-ALIAS '},LiteraryAgentPreferences:{ChatModelId:' OLD-FIXED '}} ");
        var slot = store.Add("arena_slots", "{_id:'a',PlatformId:'logical-model',ModelId:' OLD-FIXED '}");
        var engine = Engine(store); var p = await engine.PlanAsync(Mapping(), "admin");
        Assert.Equal(2, p.Changes.Count); var applied = await engine.ApplyAsync(p.Id, "internal", p.Revision); Assert.True(applied.Coverage.Verified);
        Assert.Equal("new-fixed", preferences["VisualAgentPreferences"]["ModelId"]); Assert.Equal("new-fixed", slot["ModelId"]);
        Assert.False(ModelReferenceAnalysis.Matches(Mapping().Source, "OLD-LOGICAL"));
        Assert.False(ModelReferenceAnalysis.Matches(Mapping().Source, "OLD-POOL"));
        Assert.False(ModelReferenceAnalysis.Matches(Mapping().Source, " OLD-WIRE "));
        Assert.False(ModelReferenceAnalysis.Matches(Mapping().Source, "OLD-PHYSICAL"));
        Assert.False(ModelReferenceAnalysis.Matches(Mapping().Source, "OLD-UPSTREAM"));
        Assert.True(MongoRuntimeModelReferenceSnapshotProvider.Matches(Mapping().Source, new("c", "p", "public-id", " OLD-ALIAS ")));
    }

    [Fact]
    public async Task RegisteredMigratedPoolAcceptsOnlyExactBareOrPrefixedIds()
    {
        var store = new MemoryStore(); var doc = store.Add("user_preferences", "{_id:'u',VisualAgentPreferences:{ModelId:'pool_old-pool'}}");
        var engine = Engine(store); var plan = await engine.PlanAsync(Mapping(), "admin");
        Assert.Single(plan.Changes); var done = await engine.ApplyAsync(plan.Id, "internal", plan.Revision);
        Assert.True(done.Coverage.Verified); Assert.Equal("pool_new-logical", doc["VisualAgentPreferences"]["ModelId"]);
        Assert.False(ModelReferenceAnalysis.Matches(Mapping().Source, "pool_OLD-POOL"));
        Assert.True(MongoRuntimeModelReferenceSnapshotProvider.Matches(Mapping().Source, new("c", "p", "pool-id", "pool_old-pool")));
        Assert.False(MongoRuntimeModelReferenceSnapshotProvider.Matches(Mapping().Source, new("c", "p", "pool-id", "pool_OLD-POOL")));
    }

    [Theory]
    [InlineData("applying", -5, true)]
    [InlineData("applying", 5, false)]
    [InlineData("applying", null, true)]
    [InlineData("completed", -5, false)]
    [InlineData("blocked", null, false)]
    [InlineData("planned", -5, false)]
    public void ResumeIsExplicitAndOnlyAvailableWithoutAnActiveLease(string status, int? minutes, bool expected)
    {
        var plan = new ReferenceMigrationPlan { Status = status, LeaseUntil = minutes is null ? null : DateTime.UtcNow.AddMinutes(minutes.Value) };
        Assert.Equal(expected, plan.CanResume);
        Assert.DoesNotContain("CanResume", plan.ToBsonDocument().Names); // derived from current clock, never persisted as stale truth
    }
    [Fact]
    public async Task ExpiredApplyingLeaseResumesOriginalIntentAndReconcilesPartialLostAcknowledgement()
    {
        var store = new MemoryStore();
        var first = store.Add("arena_slots", "{_id:'first',LogicalModelId:'old-logical'}");
        var second = store.Add("arena_slots", "{_id:'second',LogicalModelId:'old-logical'}");
        var engine = Engine(store); var plan = await engine.PlanAsync(Mapping(), "admin");
        foreach (var field in plan.Changes.Single(x => x.RecordId == "first").Fields) MemoryStore.Set(first, field.Path, field.After);
        plan.Status = "applying"; plan.LeaseToken = "crashed-holder"; plan.LeaseUntil = DateTime.UtcNow.AddMinutes(-1); plan.Revision = 4;
        store.Plans[plan.Id] = plan;
        var original = await engine.GetAsync(plan.Id, "internal"); Assert.True(original.CanResume);
        var resumed = await engine.ApplyAsync(original.Id, "internal", original.Revision);
        Assert.Equal(plan.Id, resumed.Id); Assert.Equal("completed", resumed.Status); Assert.True(resumed.Coverage.Verified);
        Assert.Equal("new-logical", second["LogicalModelId"]); Assert.Equal(1, store.Writes); Assert.False(resumed.CanResume);
        Assert.Null(resumed.LeaseToken); Assert.Null(resumed.LeaseUntil); Assert.All(resumed.Changes, x => Assert.Equal("applied", x.Status));
    }
    [Fact]
    public async Task ExpiredIntentRecoveryRejectsConcurrentUserEditAndFreshOrStaleRevision()
    {
        var store = new MemoryStore(); var first = store.Add("arena_slots", "{_id:'first',LogicalModelId:'old-logical'}");
        var second = store.Add("arena_slots", "{_id:'second',LogicalModelId:'old-logical'}");
        var engine = Engine(store); var plan = await engine.PlanAsync(Mapping(), "admin");
        foreach (var field in plan.Changes.Single(x => x.RecordId == "first").Fields) MemoryStore.Set(first, field.Path, field.After);
        plan.Status = "applying"; plan.LeaseUntil = DateTime.UtcNow.AddMinutes(2); store.Plans[plan.Id] = plan;
        Assert.False((await engine.GetAsync(plan.Id, "internal")).CanResume);
        Assert.Equal("REFERENCE_PLAN_BUSY", (await Assert.ThrowsAsync<ModelReferenceException>(() => engine.ApplyAsync(plan.Id, "internal", plan.Revision))).Code);
        plan.LeaseUntil = DateTime.UtcNow.AddMinutes(-1); plan.Revision++; store.Plans[plan.Id] = plan;
        Assert.Equal("REFERENCE_PLAN_BUSY", (await Assert.ThrowsAsync<ModelReferenceException>(() => engine.ApplyAsync(plan.Id, "internal", plan.Revision - 1))).Code);
        second["LogicalModelId"] = "administrator-other-model";
        var conflict = await engine.ApplyAsync(plan.Id, "internal", plan.Revision);
        Assert.Equal(plan.Id, conflict.Id); Assert.Equal("conflict", conflict.Status); Assert.False(conflict.Coverage.Verified);
        Assert.Equal("administrator-other-model", second["LogicalModelId"]); Assert.Equal("new-logical", first["LogicalModelId"]);
        Assert.Equal(0, store.Writes);
    }
}
