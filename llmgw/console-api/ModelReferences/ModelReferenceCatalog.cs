using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.ModelUpgrades;
using PrdAgent.LlmGw.Mongo;
using PrdAgent.LlmGw.LogicalModels;

namespace PrdAgent.LlmGw.ModelReferences;

/// <summary>Resolve identities on the server. Client names never establish tenant ownership or authorization.</summary>
public sealed class ModelReferenceCatalog(IMongoDatabase gateway, IMongoDatabase map, string internalTenantId) : IModelReferenceTargetValidator
{
    private static readonly FilterDefinitionBuilder<BsonDocument> F = Builders<BsonDocument>.Filter;
    private IMongoCollection<BsonDocument> Collection(string name) => gateway.GetCollection<BsonDocument>(name);
    private async Task<BsonDocument> RequiredAsync(string collection, string tenant, string id, CancellationToken ct)
        => await Collection(collection).Find(F.And(F.Eq("TenantId", tenant), F.Eq("_id", id)))
            .Project(SafeProjection(collection)).FirstOrDefaultAsync(ct)
            ?? throw new ModelReferenceException("REFERENCE_IDENTITY_NOT_FOUND", "模型身份不存在或不属于当前组织，请刷新目录后重试。");
    private static ProjectionDefinition<BsonDocument> SafeProjection(string collection)
        => collection switch
        {
            "llmgw_logical_models" => new BsonDocument { { "PublicId", 1 }, { "Aliases", 1 }, { "MigratedFromPoolIds", 1 }, { "Enabled", 1 }, { "ModelType", 1 }, { "Capabilities", 1 }, { "AllowedAppCallerCodes", 1 }, { "UpdatedAt", 1 } },
            "llmgw_models" => new BsonDocument { { "PlatformId", 1 }, { "ModelName", 1 }, { "Enabled", 1 }, { "Capabilities", 1 } },
            _ => new BsonDocument { { "Enabled", 1 } },
        };
    public async Task<ReferenceMigrationMapping> BuildAsync(string tenant, string sourceId, string targetId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(sourceId) || string.IsNullOrWhiteSpace(targetId) || sourceId.Length > 200 || targetId.Length > 200 || sourceId == targetId)
            throw new ModelReferenceException("REFERENCE_MODEL_PAIR_REQUIRED", "请选择明确的原模型和不同的目标模型。");
        var source = await RequiredAsync("llmgw_logical_models", tenant, sourceId, ct);
        var target = await RequiredAsync("llmgw_logical_models", tenant, targetId, ct);
        if (source.GetStringOrEmpty("ModelType") != target.GetStringOrEmpty("ModelType"))
            throw new ModelReferenceException("REFERENCE_MODEL_TYPE_MISMATCH", "原模型与目标模型用途不同，请选择同用途的替代模型。");
        return new() { TenantId = tenant, ModelType = source.GetStringOrEmpty("ModelType"), Source = await IdentityAsync(tenant, source, false, ct), Target = await IdentityAsync(tenant, target, true, ct) };
    }
    public async Task<(ReferenceIdentity Identity, string ModelType)> ReadIdentityAsync(string tenant, string logicalId, CancellationToken ct)
    {
        var logical = await RequiredAsync("llmgw_logical_models", tenant, logicalId, ct);
        return (await IdentityAsync(tenant, logical, true, ct), logical.GetStringOrEmpty("ModelType"));
    }
    public async Task<ReferenceIdentity?> ReadKnownSourceAsync(string tenant, string logicalId, CancellationToken ct)
    {
        var sources = await Collection("llmgw_logical_models").Find(F.And(F.Eq("TenantId", tenant),
                F.Or(F.Eq("_id", logicalId), F.AnyEq("MigratedFromPoolIds", logicalId))))
            .Project(SafeProjection("llmgw_logical_models")).Limit(2).ToListAsync(ct);
        if (sources.Count > 1) throw new ModelReferenceException("REFERENCE_SOURCE_AMBIGUOUS", "原引用对应多个目录身份，请先修复目录冲突。");
        return sources.Count == 0 ? null : await IdentityAsync(tenant, sources[0], false, ct);
    }
    public async Task<ReferenceIdentity?> ReadKnownPublicSourceAsync(string tenant, string publicId, string modelType, CancellationToken ct)
    {
        var normalized = publicId.Trim().ToLowerInvariant();
        var candidates = await Collection("llmgw_logical_models").Find(F.And(F.Eq("TenantId", tenant), F.Eq("ModelType", modelType),
                F.Or(F.Eq("PublicIdNormalized", normalized), F.Eq("PublicId", publicId.Trim()), F.AnyEq("Aliases", normalized))))
            .Project(SafeProjection("llmgw_logical_models")).Limit(2).ToListAsync(ct);
        if (candidates.Count > 1) throw new ModelReferenceException("REFERENCE_SOURCE_AMBIGUOUS", "原引用对应多个目录身份，请先修复目录冲突。");
        return candidates.Count == 1 ? await IdentityAsync(tenant, candidates[0], false, ct) : null;
    }
    public async Task<ReferenceMigrationMapping> BuildRetirementAsync(string tenant, string logicalId, CancellationToken ct)
    {
        var logical = await RequiredAsync("llmgw_logical_models", tenant, logicalId, ct);
        return new() { TenantId = tenant, ModelType = logical.GetStringOrEmpty("ModelType"), Source = new()
        {
            LogicalId = logicalId, PublicId = logical.GetStringOrEmpty("PublicId"),
            Aliases = ModelUpgradeRules.Strings(logical, "Aliases"), PoolIds = ModelUpgradeRules.Strings(logical, "MigratedFromPoolIds"),
        } };
    }
    public async Task<ReferenceMigrationMapping> BuildSwitchAsync(string tenant, string logicalId, ModelUpgradeTarget current, ModelUpgradeCandidate candidate, CancellationToken ct = default)
    {
        var logical = await RequiredAsync("llmgw_logical_models", tenant, logicalId, ct);
        var source = await IdentityAsync(tenant, logical, false, ct);
        source.OfferingId = current.OfferingId; source.PhysicalModelId = current.ModelId;
        source.ProviderId = current.ProviderId; source.UpstreamModelId = current.UpstreamModelId;
        // A stable identity is retained. Only the explicit physical successor changes.
        var target = new ReferenceIdentity { LogicalId = source.LogicalId, PublicId = source.PublicId,
            Aliases = [.. source.Aliases], PoolIds = [.. source.PoolIds], PhysicalModelId = candidate.ModelId,
            ProviderId = candidate.ProviderId, UpstreamModelId = candidate.UpstreamModelId,
            HasCatalogSnapshot = true, ModelType = source.ModelType, Capabilities = [.. source.Capabilities], AllowedAppCallerCodes = [.. source.AllowedAppCallerCodes],
            OfferingId = candidate.ValidationRoute?.OfferingId, OfferingFingerprint = candidate.ValidationRoute?.OfferingVersion };
        return new() { TenantId = tenant, ModelType = logical.GetStringOrEmpty("ModelType"), Source = source, Target = target };
    }
    private async Task<ReferenceIdentity> IdentityAsync(string tenant, BsonDocument logical, bool requireRoute, CancellationToken ct)
    {
        var id = logical.GetStringOrEmpty("_id");
        var routes = await Collection("llmgw_model_offerings")
            .Find(F.And(F.Eq("TenantId", tenant), F.Eq("LogicalModelId", id), F.Eq("Enabled", true)))
            .Project(new BsonDocument { { "LogicalModelId", 1 }, { "TargetId", 1 }, { "TargetKind", 1 }, { "UpstreamModelId", 1 }, { "Protocol", 1 }, { "EndpointPath", 1 }, { "Enabled", 1 } }).Limit(2).ToListAsync(ct);
        if (routes.Count > 1 || requireRoute && routes.Count != 1)
            throw new ModelReferenceException("REFERENCE_ROUTE_AMBIGUOUS", "模型需要唯一且可核对的启用线路；请先明确线路，再迁移其使用位置。");
        var identity = new ReferenceIdentity { LogicalId = id, PublicId = logical.GetStringOrEmpty("PublicId"),
            HasCatalogSnapshot = true, ModelType = logical.GetStringOrEmpty("ModelType"),
            Capabilities = ModelUpgradeRules.Strings(logical, "Capabilities"), AllowedAppCallerCodes = ModelUpgradeRules.Strings(logical, "AllowedAppCallerCodes"),
            Aliases = ModelUpgradeRules.Strings(logical, "Aliases"), PoolIds = ModelUpgradeRules.Strings(logical, "MigratedFromPoolIds") };
        if (routes.Count == 0) return identity;
        var route = routes[0];
        if (route.AsNullableString("TargetKind") is { } kind && kind != "model")
            throw new ModelReferenceException("REFERENCE_EXCHANGE_REQUIRES_MAPPING", "该模型使用转接线路，需要先明确其实际替代身份；系统不会按名称猜测。");
        var physical = await RequiredAsync("llmgw_models", tenant, route.GetStringOrEmpty("TargetId"), ct);
        identity.OfferingId = route.GetStringOrEmpty("_id"); identity.PhysicalModelId = physical.GetStringOrEmpty("_id");
        identity.OfferingFingerprint = ModelUpgradeWire.Fingerprint(route);
        identity.ProviderId = physical.GetStringOrEmpty("PlatformId");
        identity.UpstreamModelId = route.AsNullableString("UpstreamModelId") ?? physical.GetStringOrEmpty("ModelName");
        return identity;
    }
    public async Task<IReadOnlyList<string>> ValidateAsync(ReferenceMigrationMapping mapping, IReadOnlyList<string> consumerKeys, CancellationToken ct)
    {
        var target = await RequiredAsync("llmgw_logical_models", mapping.TenantId, mapping.Target.LogicalId ?? "", ct);
        var model = await RequiredAsync("llmgw_models", mapping.TenantId, mapping.Target.PhysicalModelId ?? "", ct);
        var provider = await RequiredAsync("llmgw_platforms", mapping.TenantId, model.GetStringOrEmpty("PlatformId"), ct);
        List<string> reasons;
        if (!string.IsNullOrEmpty(mapping.ScopeConsumerKey))
        {
            // Scoped orphan sources need not exist in the directory. Their purpose is derived from persisted typed fields.
            reasons = ValidateScopedTarget(mapping, target, model, provider);
            if (!string.IsNullOrEmpty(mapping.Source.LogicalId))
            {
                var knownSource = await Collection("llmgw_logical_models").Find(F.And(F.Eq("TenantId", mapping.TenantId), F.Eq("_id", mapping.Source.LogicalId)))
                    .Project(SafeProjection("llmgw_logical_models")).FirstOrDefaultAsync(ct);
                if (knownSource is not null) reasons.AddRange(ValidateDocuments(knownSource, target, model, provider));
            }
            if (mapping.Source.HasCatalogSnapshot)
            {
                var snapshot = new BsonDocument { { "ModelType", mapping.Source.ModelType }, { "Capabilities", new BsonArray(mapping.Source.Capabilities) },
                    { "AllowedAppCallerCodes", new BsonArray(mapping.Source.AllowedAppCallerCodes) } };
                reasons.AddRange(ValidateDocuments(snapshot, target, model, provider));
            }
        }
        else
        {
            if (!mapping.Source.HasCatalogSnapshot || mapping.Source.ModelType != mapping.ModelType)
                return ["缺少计划建立时的原模型能力与用途快照，请重新建立完整计划。"];
            // Source retirement is expected after migration. Its frozen authorization contract must survive deletion.
            var sourceSnapshot = new BsonDocument { { "ModelType", mapping.Source.ModelType },
                { "Capabilities", new BsonArray(mapping.Source.Capabilities) }, { "AllowedAppCallerCodes", new BsonArray(mapping.Source.AllowedAppCallerCodes) } };
            reasons = ValidateDocuments(sourceSnapshot, target, model, provider);
            var source = await Collection("llmgw_logical_models").Find(F.And(F.Eq("TenantId", mapping.TenantId), F.Eq("_id", mapping.Source.LogicalId ?? "")))
                .Project(SafeProjection("llmgw_logical_models")).FirstOrDefaultAsync(ct);
            if (source is not null) reasons.AddRange(ValidateDocuments(source, target, model, provider));
        }
        if (model.GetStringOrEmpty("PlatformId") != mapping.Target.ProviderId)
            reasons.Add("目标物理线路在计划生成后发生变化，请重新核对明确身份。");
        var route = await Collection("llmgw_model_offerings").Find(F.And(F.Eq("TenantId", mapping.TenantId),
                F.Eq("_id", mapping.Target.OfferingId ?? "")))
            .Project(new BsonDocument { { "LogicalModelId", 1 }, { "TargetId", 1 }, { "TargetKind", 1 }, { "UpstreamModelId", 1 }, { "Protocol", 1 }, { "EndpointPath", 1 }, { "Enabled", 1 } })
            .FirstOrDefaultAsync(ct);
        var stableSwitch = mapping.Source.LogicalId == mapping.Target.LogicalId
            && !string.IsNullOrEmpty(mapping.Source.PhysicalModelId) && mapping.Source.PhysicalModelId != mapping.Target.PhysicalModelId;
        if (route is null || !route.GetValue("Enabled", false).ToBoolean()
            || (route.AsNullableString("TargetKind") ?? "model") != "model"
            || route.GetStringOrEmpty("TargetId") != mapping.Target.PhysicalModelId
            || !stableSwitch && route.GetStringOrEmpty("LogicalModelId") != mapping.Target.LogicalId
            || (route?.AsNullableString("UpstreamModelId") ?? model.GetStringOrEmpty("ModelName")) != mapping.Target.UpstreamModelId)
            reasons.Add("目标线路已停用、删除或改指其他供给，请重新检查计划；原配置不应迁入失效线路。");
        if (route is not null && (string.IsNullOrEmpty(mapping.Target.OfferingFingerprint)
                || ModelUpgradeWire.Fingerprint(route) != mapping.Target.OfferingFingerprint))
            reasons.Add("目标线路的协议或请求路径在计划生成后发生变化，请重新核对目标线路。");
        if (stableSwitch && route is not null)
        {
            // Automatic promotion independently validates the frozen proof route immediately before switching.
            var proofLogical = await RequiredAsync("llmgw_logical_models", mapping.TenantId, route.GetStringOrEmpty("LogicalModelId"), ct);
            if (!proofLogical.GetValue("Enabled", false).ToBoolean() || proofLogical.GetStringOrEmpty("ModelType") != target.GetStringOrEmpty("ModelType"))
                reasons.Add("升级候选的验收线路已失效或用途发生变化。");
        }
        return reasons;
    }
    public async Task<IReadOnlyList<string>> ValidateFindingsAsync(ReferenceMigrationMapping mapping, IReadOnlyList<ReferenceFinding> findings, CancellationToken ct)
    {
        var reasons = (await ValidateAsync(mapping, findings.Select(x => x.ConsumerKey).Distinct(StringComparer.Ordinal).ToArray(), ct)).ToList();
        var target = await RequiredAsync("llmgw_logical_models", mapping.TenantId, mapping.Target.LogicalId ?? "", ct);
        foreach (var finding in findings.Where(x => x.Status == "affected"))
        {
            var callers = RequiredCallers(finding.ConsumerKey, finding.Path, mapping.ModelType ?? target.GetStringOrEmpty("ModelType"));
            if (finding.ConsumerKey.StartsWith("map.lab-", StringComparison.Ordinal) && target.GetStringOrEmpty("ModelType") == "generation")
            {
                if (!callers.Any(caller => LogicalModelCapabilityPolicy.SupportsAppCallerScenario(ModelUpgradeRules.Strings(target, "Capabilities"),
                    ModelUpgradeRules.Strings(target, "AllowedAppCallerCodes"), caller)))
                    reasons.Add("目标模型不在模型实验台的生图用途授权目录中。");
                continue;
            }
            foreach (var caller in callers)
                if (!LogicalModelCapabilityPolicy.SupportsAppCallerScenario(ModelUpgradeRules.Strings(target, "Capabilities"),
                    ModelUpgradeRules.Strings(target, "AllowedAppCallerCodes"), caller))
                    reasons.Add("目标模型尚未获得此使用位置的能力和调用用途授权：" + finding.ConsumerKey);
        }
        if (mapping.TenantId == internalTenantId && findings.Any(x => x.Status == "affected"
                && (x.ConsumerKey == "map.preferences" && x.Path.StartsWith("VisualAgentPreferences.", StringComparison.Ordinal)
                    || x.ConsumerKey.StartsWith("map.lab-", StringComparison.Ordinal) && target.GetStringOrEmpty("ModelType") == "generation")))
        {
            var policy = await map.GetCollection<BsonDocument>("appsettings").Find(F.Exists("VisualModelPolicy"))
                .Project(new BsonDocument { { "VisualModelPolicy.Models.ModelId", 1 } }).FirstOrDefaultAsync(ct);
            var allowed = policy is not null && ModelReferenceAnalysis.TryGet(policy, "VisualModelPolicy.Models", out var entries) && entries is BsonArray array
                && array.OfType<BsonDocument>().Any(x => x.GetStringOrEmpty("ModelId") == mapping.Target.PublicId);
            if (!allowed) reasons.Add("目标模型尚未进入视觉创作的业务开放清单，请先明确开放策略，迁移不会扩大业务授权。");
        }
        return reasons.Distinct(StringComparer.Ordinal).ToArray();
    }
    internal static IReadOnlyList<string> RequiredCallers(string consumer, string path, string modelType) => consumer switch
    {
        "map.arena-slots" => ["prd-agent.arena.battle::chat"],
        "map.lab-experiments" or "map.lab-modelsets" or "map.lab-groups" when modelType == "generation"
            => ["visual-agent.image.text2img::generation", "visual-agent.image-gen.batch-generate::generation"],
        "map.lab-experiments" or "map.lab-modelsets" or "map.lab-groups" => ["prd-agent-web.model-lab.run::chat"],
        "map.preferences" when path == "LiteraryAgentPreferences.ChatModelId" => ["literary-agent.content::chat"],
        "map.preferences" when path == "LiteraryAgentPreferences.ImageModelId" => ["literary-agent.illustration.text2img::generation", "literary-agent.illustration.img2img::generation"],
        "map.preferences" when path == "VisualAgentPreferences.ModelId" => ["visual-agent.image.text2img::generation", "visual-agent.image.img2img::generation", "visual-agent.image.vision::generation"],
        _ => [],
    };
    private static List<string> ValidateScopedTarget(ReferenceMigrationMapping mapping, BsonDocument target, BsonDocument model, BsonDocument provider)
    {
        var reasons = ValidateDocuments(target, target, model, provider);
        if (mapping.ModelType != target.GetStringOrEmpty("ModelType") || RequiredCallers(mapping.ScopeConsumerKey ?? "", mapping.ScopePath ?? "", mapping.ModelType ?? "").Count == 0)
            reasons.Add("该孤立引用没有已登记的用途迁移规则，请先补齐明确规则。");
        return reasons;
    }
    public static List<string> ValidateDocuments(BsonDocument source, BsonDocument target, BsonDocument model, BsonDocument provider)
    {
        var reasons = new List<string>();
        if (!target.GetValue("Enabled", false).ToBoolean() || !model.GetValue("Enabled", false).ToBoolean() || !provider.GetValue("Enabled", false).ToBoolean())
            reasons.Add("目标模型或其上游已停用，请先恢复并验证目标线路。");
        var type = source.GetStringOrEmpty("ModelType");
        if (type != target.GetStringOrEmpty("ModelType")) reasons.Add("目标模型用途与原模型不同。");
        var capabilities = ModelUpgradeRules.Strings(target, "Capabilities").ToHashSet(StringComparer.Ordinal);
        if (ModelUpgradeRules.Strings(source, "Capabilities").Any(x => !capabilities.Contains(x)))
            reasons.Add("目标模型未保留原模型声明的全部能力，需先明确受影响用途。");
        var physicalCapabilities = ModelUpgradeRules.PhysicalCapabilities(model, type).ToHashSet(StringComparer.Ordinal);
        if (capabilities.Any(x => !physicalCapabilities.Contains(x))) reasons.Add("目标物理线路能力不足以承接目标逻辑模型。");
        var sourceAllowed = ModelUpgradeRules.Strings(source, "AllowedAppCallerCodes");
        var targetAllowed = ModelUpgradeRules.Strings(target, "AllowedAppCallerCodes");
        if (targetAllowed.Count > 0 && (sourceAllowed.Count == 0 || sourceAllowed.Any(x => !targetAllowed.Contains(x, StringComparer.OrdinalIgnoreCase))))
            reasons.Add("目标模型未保留原调用用途授权，请先核对授权；迁移不会扩充调用权限。");
        return reasons;
    }
}
