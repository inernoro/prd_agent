using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.ModelReferences;

/// <summary>Expected MAP deployment identity/scope/commit are supplied explicitly by the host, never inferred from console-only configuration.</summary>
public sealed class MongoRuntimeModelReferenceSnapshotProvider(IMongoDatabase map, string expectedDeploymentIdentity,
    string? expectedDeploymentScope, string? expectedDurableScope, string expectedCommit) : IRuntimeModelReferenceSnapshotProvider
{
    public const string CollectionName = "model_runtime_reference_snapshots";
    public static readonly string[] ExpectedConsumerKeys = ["chat-agent.default", "claude-sidecar.default", "llm.environment-fallback", "llm.main-model", "llm.active-config", "sdk.openai.default", "sdk.claude.default", "design-artifact.model", "design-artifact.pool", "design-artifact.pinned-model"];
    public static string KindFor(string key) => key switch
    {
        "design-artifact.pool" => "pool-id",
        "llm.main-model" or "design-artifact.pinned-model" => "physical-pair",
        "llm.environment-fallback" or "llm.active-config" or "design-artifact.model" => "public-id",
        _ => "upstream-model-id",
    };
    public static readonly string[] RequiredDefaultKeys = ["chat-agent.default", "claude-sidecar.default", "llm.environment-fallback", "sdk.openai.default", "sdk.claude.default"];
    public static readonly string[] IdentityKinds = ["public-id", "pool-id", "physical-pair", "upstream-model-id"];
    public async Task<RuntimeModelReferenceSnapshot> ReadAsync(ReferenceMigrationMapping mapping, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(expectedDeploymentIdentity) || expectedCommit.Length != 40)
            return new(false, []);
        var filter = Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", mapping.TenantId),
            Builders<BsonDocument>.Filter.Eq("DeploymentIdentity", expectedDeploymentIdentity),
            Builders<BsonDocument>.Filter.Eq<BsonValue>("DurableScope", expectedDurableScope is null ? BsonNull.Value : new BsonString(expectedDurableScope)),
            Builders<BsonDocument>.Filter.Gt("ExpiresAt", DateTime.UtcNow));
        var projection = new BsonDocument(new[] { "SchemaVersion", "TenantId", "DeploymentIdentity", "DeploymentScope", "DurableScope", "ActualCommit", "HeartbeatAt", "ExpiresAt", "InstanceId", "ExpectedConsumerKeys", "Entries.ConsumerKey", "Entries.Path", "Entries.IdentityKind", "Entries.Value", "Entries.PlatformId", "Entries.State", "LegacyFallbackAuthority" }.Select(x => new BsonElement(x, 1)));
        var rows = await map.GetCollection<BsonDocument>(CollectionName).Find(filter).Project(projection).Limit(101).ToListAsync(ct);
        return Validate(rows, mapping.TenantId, expectedDeploymentIdentity, expectedDeploymentScope, expectedDurableScope, expectedCommit, DateTime.UtcNow);
    }
    private static string? Text(BsonDocument doc, string key) => doc.TryGetValue(key, out var value) && value.IsString ? value.AsString : null;
    public static RuntimeModelReferenceSnapshot Validate(IReadOnlyList<BsonDocument> rows, string tenantId,
        string deploymentIdentity, string? deploymentScope, string? durableScope, string commit, DateTime now)
    {
        if (rows.Count is 0 or > 100 || string.IsNullOrWhiteSpace(deploymentIdentity) || commit.Length != 40) return new(false, []);
        var entries = new List<ReferenceSnapshotEntry>(); var instances = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            if (row.GetValue("SchemaVersion", 0) != new BsonInt32(1) || Text(row, "TenantId") != tenantId
                || !row.Contains("DeploymentScope") || !row.Contains("DurableScope")
                || Text(row, "DeploymentIdentity") != deploymentIdentity || Text(row, "DeploymentScope") != deploymentScope
                || Text(row, "DurableScope") != durableScope || Text(row, "ActualCommit") != commit
                || !row.TryGetValue("HeartbeatAt", out var heartbeat) || !heartbeat.IsValidDateTime || heartbeat.ToUniversalTime() < now.AddMinutes(-2) || heartbeat.ToUniversalTime() > now.AddSeconds(30)
                || !row.TryGetValue("ExpiresAt", out var expiry) || !expiry.IsValidDateTime || expiry.ToUniversalTime() <= now || expiry.ToUniversalTime() > heartbeat.ToUniversalTime().AddMinutes(3)
                || string.IsNullOrWhiteSpace(Text(row, "InstanceId")) || !instances.Add(Text(row, "InstanceId")!)
                || Text(row, "LegacyFallbackAuthority") is not ("gateway-only" or "legacy-fallback-permitted")) return new(false, []);
            if (row.GetValue("ExpectedConsumerKeys", BsonNull.Value) is not BsonArray keys || keys.Any(x => !x.IsString)
                || keys.Count != ExpectedConsumerKeys.Length || !keys.Select(x => x.AsString).ToHashSet(StringComparer.Ordinal).SetEquals(ExpectedConsumerKeys)
                || row.GetValue("Entries", BsonNull.Value) is not BsonArray values || values.Count != ExpectedConsumerKeys.Length) return new(false, []);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var value in values)
            {
                if (value is not BsonDocument d) return new(false, []);
                var key = Text(d, "ConsumerKey"); var path = Text(d, "Path"); var kind = Text(d, "IdentityKind"); var state = Text(d, "State");
                var model = Text(d, "Value"); var platform = Text(d, "PlatformId");
                if (d.TryGetValue("Value", out var rawValue) && !rawValue.IsBsonNull && !rawValue.IsString
                    || d.TryGetValue("PlatformId", out var rawPlatform) && !rawPlatform.IsBsonNull && !rawPlatform.IsString) return new(false, []);
                if (key is null || !ExpectedConsumerKeys.Contains(key, StringComparer.Ordinal) || !seen.Add(key)
                    || string.IsNullOrWhiteSpace(path) || path.Length > 250 || path.Any(char.IsControl)
                    || kind is null || !IdentityKinds.Contains(kind, StringComparer.Ordinal) || kind != KindFor(key) || state is not ("configured" or "default" or "none")
                    || state == "none" && RequiredDefaultKeys.Contains(key, StringComparer.Ordinal)
                    || state == "none" && (!d.Contains("Value") || !d["Value"].IsBsonNull || platform is not null)
                    || state != "none" && (string.IsNullOrWhiteSpace(model) || model.Length > 200 || model.Any(char.IsControl))
                    || kind == "physical-pair" && state != "none" && string.IsNullOrWhiteSpace(platform)
                    || kind != "physical-pair" && platform is not null) return new(false, []);
                if (state != "none") entries.Add(new(key, path!, kind, model!, platform));
            }
        }
        return new(true, entries);
    }
    public static bool Matches(ReferenceIdentity identity, ReferenceSnapshotEntry entry) => entry.IdentityKind switch
    {
        "logical-id" => !string.IsNullOrEmpty(identity.LogicalId) && entry.Value == identity.LogicalId,
        "public-id" => !string.IsNullOrEmpty(entry.Value) && (entry.Value == identity.PublicId || identity.Aliases.Contains(entry.Value, StringComparer.Ordinal)),
        "pool-id" => !string.IsNullOrEmpty(entry.Value) && (entry.Value == identity.LogicalId || identity.PoolIds.Contains(entry.Value, StringComparer.Ordinal)
            || !string.IsNullOrEmpty(identity.LogicalId) && entry.Value == "pool_" + identity.LogicalId),
        "physical-pair" => !string.IsNullOrEmpty(identity.ProviderId) && entry.ProviderId == identity.ProviderId
            && !string.IsNullOrEmpty(entry.Value) && (entry.Value == identity.PhysicalModelId || entry.Value == identity.UpstreamModelId),
        "upstream-model-id" => !string.IsNullOrEmpty(identity.UpstreamModelId) && entry.Value == identity.UpstreamModelId,
        "offering-id" => !string.IsNullOrEmpty(identity.OfferingId) && entry.Value == identity.OfferingId,
        _ => false,
    };
}
