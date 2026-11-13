using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.ModelReferences;

public sealed record RepairableModelUsage(string ConsumerKey, string RecordId, string Path, string ModelType,
    string Value, string? PlatformId, string? LogicalId, string Status, bool CanConfirmPurpose = false, string? Fingerprint = null);
public sealed record ReferenceUsagePlanRequest(string ConsumerKey, string RecordId, string Path, string TargetLogicalId, string ClientRequestId, string? ConfirmedModelType = null, string? ExpectedUsageFingerprint = null);

/// <summary>Repair sources are read from typed persisted configuration, never accepted as arbitrary client strings.</summary>
public sealed class ModelReferenceUsageCatalog(IMongoDatabase gateway, IModelReferenceStore store,
    ModelReferenceCatalog catalog, string internalTenantId)
{
    private static readonly IReadOnlySet<string> SupportedConsumers = new HashSet<string>(StringComparer.Ordinal)
    { "map.preferences", "map.arena-slots", "map.lab-experiments", "map.lab-modelsets", "map.lab-groups" };
    private static string UsageFingerprint(string consumer, string id, string path, string value, string? platform, string? logical)
        => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
            System.Text.Json.JsonSerializer.Serialize(new[] { consumer, id, path, value, platform, logical })))).ToLowerInvariant();

    public async Task<IReadOnlyList<RepairableModelUsage>> ReadAsync(string tenantId, CancellationToken ct)
    {
        if (tenantId != internalTenantId) return [];
        var f = Builders<BsonDocument>.Filter;
        var logicals = await gateway.GetCollection<BsonDocument>("llmgw_logical_models")
            .Find(f.Eq("TenantId", tenantId))
            .Project(new BsonDocument { { "PublicId", 1 }, { "Aliases", 1 }, { "MigratedFromPoolIds", 1 }, { "ModelType", 1 }, { "Enabled", 1 } }).ToListAsync(ct);
        var result = new List<RepairableModelUsage>();
        foreach (var definition in ModelReferenceRegistry.Collections.Where(x => SupportedConsumers.Contains(x.Key)))
        {
            var docs = await store.ReadAsync(definition, tenantId, ct);
            foreach (var doc in docs)
            {
                var id = doc.GetStringOrEmpty("_id");
                void Add(string path, string type, string? platform = null, string? logicalId = null, bool allowPurposeConfirmation = false)
                {
                    if (!ModelReferenceAnalysis.TryGet(doc, path, out var raw) || raw.IsBsonNull || raw.IsString && raw.AsString.Length == 0) return;
                    if (!raw.IsString) { result.Add(new(definition.Key, id, path, type, "", platform, logicalId, "unknown")); return; }
                    var value = raw.AsString;
                    var fingerprint = UsageFingerprint(definition.Key, id, path, value, platform, logicalId);
                    var matching = logicals.Where(x =>
                        !string.IsNullOrEmpty(logicalId) ? x.GetStringOrEmpty("_id") == logicalId :
                        platform is not null && platform != "logical-model" ? false :
                        string.Equals(value.Trim(), x.GetStringOrEmpty("PublicId"), StringComparison.OrdinalIgnoreCase) || value == x.GetStringOrEmpty("_id") || value == "pool_" + x.GetStringOrEmpty("_id")
                        || ModelUpgrades.ModelUpgradeRules.Strings(x, "Aliases").Contains(value.Trim(), StringComparer.OrdinalIgnoreCase)
                        || ModelUpgrades.ModelUpgradeRules.Strings(x, "MigratedFromPoolIds").Any(pool => value == pool || value == "pool_" + pool)).ToList();
                    if (type.Length == 0)
                    {
                        var types = matching.Select(x => x.GetStringOrEmpty("ModelType")).Distinct(StringComparer.Ordinal).ToArray();
                        if (types.Length != 1 || types[0] is not ("chat" or "generation"))
                        { result.Add(new(definition.Key, id, path, "", value, platform, logicalId, "unknown", allowPurposeConfirmation && matching.Count == 0 && !string.IsNullOrWhiteSpace(value), fingerprint)); return; }
                        type = types[0];
                    }
                    var matches = matching.Any(x => x.GetStringOrEmpty("ModelType") == type && x.GetValue("Enabled", false) == BsonBoolean.True);
                    result.Add(new(definition.Key, id, path, type, value, platform, logicalId, matches ? "available" : "orphan", false, fingerprint));
                }
                if (definition.Key == "map.preferences")
                {
                    if (!ModelReferenceAnalysis.TryGet(doc, "VisualAgentPreferences.ModelAuto", out var automatic) || automatic != BsonBoolean.True)
                        Add("VisualAgentPreferences.ModelId", "generation");
                    Add("LiteraryAgentPreferences.ImageModelId", "generation"); Add("LiteraryAgentPreferences.ChatModelId", "chat");
                }
                else if (definition.Key == "map.arena-slots") Add("ModelId", "chat", doc.AsNullableString("PlatformId"), doc.AsNullableString("LogicalModelId"));
                else
                {
                    var arrayName = definition.Key == "map.lab-experiments" ? "SelectedModels" : "Models";
                    if (doc.GetValue(arrayName, BsonNull.Value) is not BsonArray members) continue;
                    for (var i = 0; i < members.Count; i++)
                    {
                        if (members[i] is not BsonDocument member) { result.Add(new(definition.Key, id, $"{arrayName}.{i}", "chat", "", null, null, "unknown")); continue; }
                        var identityIsTyped = new[] { "PlatformId", "LogicalModelId", "ModelId" }
                            .All(key => !member.TryGetValue(key, out var value) || value.IsBsonNull || value.IsString);
                        Add($"{arrayName}.{i}.ModelId", "", member.AsNullableString("PlatformId"), member.AsNullableString("LogicalModelId"), identityIsTyped);
                    }
                }
            }
        }
        return result;
    }
    public async Task<ReferenceMigrationMapping> BuildAsync(string tenantId, ReferenceUsagePlanRequest request, CancellationToken ct)
    {
        var usage = (await ReadAsync(tenantId, ct)).SingleOrDefault(x => x.ConsumerKey == request.ConsumerKey && x.RecordId == request.RecordId && x.Path == request.Path)
            ?? throw new ModelReferenceException("REFERENCE_USAGE_NOT_FOUND", "该使用位置已变化或不支持直接迁移，请重新检查清单。");
        if (request.ExpectedUsageFingerprint is not null && request.ExpectedUsageFingerprint != usage.Fingerprint)
            throw new ModelReferenceException("REFERENCE_USAGE_CHANGED", "所选模型引用已变化，请重新读取原配置后再生成计划。");
        var modelType = usage.ModelType;
        if (usage.Status == "unknown")
        {
            if (!usage.CanConfirmPurpose || request.ConfirmedModelType is not ("chat" or "generation"))
                throw new ModelReferenceException("REFERENCE_USAGE_UNKNOWN", "原目录已不存在或配置结构无法核对；只有结构完整的实验模型引用，才可在明确确认用途后建立修复计划。");
            if (request.ExpectedUsageFingerprint is null)
                throw new ModelReferenceException("REFERENCE_USAGE_CHANGED", "明确用途修复必须核对所选引用快照，请重新读取原配置。");
            modelType = request.ConfirmedModelType;
        }
        else if (request.ConfirmedModelType is not null && request.ConfirmedModelType != modelType)
            throw new ModelReferenceException("REFERENCE_MODEL_TYPE_MISMATCH", "已知用途不能由人工确认改写，请按原用途迁移。");
        var target = await catalog.ReadIdentityAsync(tenantId, request.TargetLogicalId, ct);
        if (target.ModelType != modelType) throw new ModelReferenceException("REFERENCE_MODEL_TYPE_MISMATCH", "目标模型不能承接这个使用位置的用途。");
        var source = new ReferenceIdentity();
        if (!string.IsNullOrEmpty(usage.LogicalId)) source.LogicalId = usage.LogicalId;
        else if (usage.PlatformId is not null && usage.PlatformId != "logical-model")
        { source.ProviderId = usage.PlatformId; source.UpstreamModelId = usage.Value; source.PhysicalModelId = usage.Value; }
        else if (usage.Value.StartsWith("pool_", StringComparison.Ordinal)) source.LogicalId = usage.Value[5..];
        else source.PublicId = usage.Value;
        if (!string.IsNullOrEmpty(source.LogicalId))
            source = await catalog.ReadKnownSourceAsync(tenantId, source.LogicalId, ct) ?? source;
        else if (!string.IsNullOrEmpty(source.PublicId))
            source = await catalog.ReadKnownPublicSourceAsync(tenantId, source.PublicId, modelType, ct) ?? source;
        return new() { TenantId = tenantId, Source = source, Target = target.Identity, ModelType = modelType,
            ScopeConsumerKey = usage.ConsumerKey, ScopeRecordId = usage.RecordId, ScopePath = usage.Path };
    }
}
