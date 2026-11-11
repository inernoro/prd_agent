using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using PrdAgent.LlmGw.LogicalModels;
using PrdAgent.LlmGw.Mongo;
using PrdAgent.LlmGw.Provisioning;

namespace PrdAgent.LlmGw.ModelUpgrades;

public static class ModelUpgradeRules
{
    // Default daily discovery is 19:00 UTC, i.e. Asia/Shanghai 03:00. Manual checks do not move a future due time.
    public static DateTime NextCheckAt(DateTime? previous, DateTime now, int intervalHours)
    {
        if (previous is { } due) { while (due <= now) due = due.AddHours(intervalHours); return due; }
        var first = now.Date.AddHours(19);
        return first > now ? first : first.AddDays(1);
    }
    public static string StateId(string tenantId, string logicalId)
        => "upgrade-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(tenantId + "\n" + logicalId))).ToLowerInvariant();

    public static void ValidatePolicy(ModelUpgradePolicy p)
    {
        if (p.Mode is not ("manual" or "auto") || p.CheckIntervalHours is < 24 or > 168)
            throw new ModelUpgradeException("INVALID_POLICY", "请选择人工或自动策略，检查间隔须为 24 至 168 小时。", 400);
        if (p.CanaryUnitCostUpperBoundUsd is <= 0 or > 10 || p.MaxValidationCostUsd is <= 0 or > 10 || p.MaxDailyCostUsd is <= 0 or > 100
            || p.MaxPriceIncreasePercent is < 0 or > 1000 || p.Successors is null || p.Successors.Count > 20)
            throw new ModelUpgradeException("INVALID_POLICY", "验收单次预算须在 0 至 10 美元、每日预算在 0 至 100 美元之间；请核对价格涨幅与继任关系数量。", 400);
        if (p.Enabled && p.Mode == "auto" && p.AutoValidate
            && (p.CanaryUnitCostUpperBoundUsd is null || p.MaxValidationCostUsd is null || p.MaxDailyCostUsd is null || string.IsNullOrWhiteSpace(p.ValidationAppCallerCode)))
            throw new ModelUpgradeException("PROBE_BUDGET_REQUIRED", "开启自动验收前必须明确单次、每日预算及已有调用用途。", 400);
        if ((p.ValidationAppCallerCode?.Length ?? 0) > 200 || p.Successors.GroupBy(x => x.FromModel, StringComparer.Ordinal).Any(x => x.Count() > 1))
            throw new ModelUpgradeException("AMBIGUOUS_SUCCESSOR", "同一当前型号只能配置一个明确继任关系，请先移除重复配置。", 400);
        foreach (var s in p.Successors)
        {
            if (string.IsNullOrWhiteSpace(s.ProviderId) || string.IsNullOrWhiteSpace(s.FromModel) || string.IsNullOrWhiteSpace(s.ToModel)
                || s.ProviderId.Length > 200 || s.FromModel.Length > 200 || s.ToModel.Length > 200
                || !Uri.TryCreate(s.DocumentationUrl, UriKind.Absolute, out var url) || url.Scheme != "https" || url.UserInfo.Length > 0
                || s.Capabilities is null || s.Capabilities.Count == 0 || s.Capabilities.Any(c => !LogicalModelCapabilityPolicy.CanonicalCapabilities.Contains(c)))
                throw new ModelUpgradeException("INVALID_SUCCESSOR", "继任关系必须包含明确前后型号、官方 Provider、HTTPS 文档依据和规范能力声明；系统不会按名称猜测继任。", 400);
        }
    }

    public static bool IsAuthorizedValidationCaller(BsonDocument logical, BsonDocument caller)
        => caller.GetStringOrEmpty("AppCallerCode").Length > 0
           && caller.GetStringOrEmpty("RequestType") == logical.GetStringOrEmpty("ModelType")
           && CallTracePlanner.AllowsTraffic(caller.AsNullableString("Status"))
           && LogicalModelCapabilityPolicy.SupportsAppCallerScenario(Strings(logical, "Capabilities"),
               Strings(logical, "AllowedAppCallerCodes"), caller.GetStringOrEmpty("AppCallerCode"));
    public static string DefaultValidationCaller(BsonDocument logical, IEnumerable<BsonDocument> callers)
    {
        var claims = Strings(logical, "DefaultForAppCallerCodes");
        return callers.Where(c => IsAuthorizedValidationCaller(logical, c))
            .Select(c => c.GetStringOrEmpty("AppCallerCode"))
            .Where(c => claims.Contains(c, AppCallerIdentityPolicy.Comparer))
            .OrderBy(c => logical.GetStringOrEmpty("ModelType") == "generation"
                && AppCallerIdentityPolicy.Comparer.Equals(c, "visual-agent.image.text2img::generation") ? 0 : 1)
            .ThenBy(c => c, AppCallerIdentityPolicy.Comparer).FirstOrDefault() ?? "";
    }
    public static string NextAutomaticAction(ModelUpgradeState s, DateTime now)
    {
        if (s.ExecutionRequestedBy != "scheduled" || !s.Policy.Enabled || s.Policy.Mode != "auto"
            || s.Candidate is null || s.Current?.ModelId == s.Candidate.ModelId || s.OutcomeUnknown
            || !s.Gates.Capabilities || !s.Gates.Price || !s.Gates.Budget) return "";
        if (CanPromote(s, true, now)) return "promote";
        return s.Policy.AutoValidate ? "validate" : "";
    }
    public static bool IsFixedValidationTarget(BsonDocument logical, string modelType)
        => !IsStable(logical) && logical.GetStringOrEmpty("ModelType") == modelType && logical.GetValue("Enabled", false).ToBoolean();
    public static bool HasCanaryEnvelope(string model, decimal upper, decimal inputRate, decimal outputRate)
        => model is "gpt-image-2.6" or "gpt-image-2.6-sunburst" or "gpt-image-2.6-flare"
           && upper >= (1056m * Math.Max(inputRate, 5m) + 823m * Math.Max(outputRate, 30m)) / 1_000_000m;
    public static bool IsStable(BsonDocument logical) => logical.AsNullableString("IdentityKind") == "stable";
    public static List<string> Strings(BsonDocument d, string field)
        => d.GetValue(field, BsonNull.Value) is BsonArray a ? a.Where(x => x.IsString).Select(x => x.AsString).ToList() : [];
    public static List<string> PhysicalCapabilities(BsonDocument model, string logicalModelType)
    {
        if (model.GetValue("Enabled", BsonNull.Value) is not { IsBoolean: true } enabled || !enabled.AsBoolean
            || model.GetValue("Capabilities", BsonNull.Value) is not BsonArray capabilities) return [];
        var docs = capabilities.Where(x => x.IsBsonDocument).Select(x => x.AsBsonDocument).ToList();
        var codes = docs.Select(x => x.AsNullableString("Type")).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!)
            .Where(type => GatewayConfigurationProvisioning.HasEnabledCapability(docs, type));
        // Explicit false stays disabled even when legacy image_generation expands to scenario capabilities.
        var disabled = docs.Where(x => x.GetValue("Value", BsonNull.Value) is { IsBoolean: true } value && !value.AsBoolean)
            .Select(x => LogicalModelCapabilityPolicy.TryCanonicalize(x.AsNullableString("Type")))
            .Where(x => x is not null).ToHashSet(StringComparer.Ordinal);
        return LogicalModelCapabilityPolicy.Normalize(logicalModelType, codes).Where(x => !disabled.Contains(x)).ToList();
    }
    public static bool CandidateCapabilitiesPass(BsonDocument logical, ModelSuccessor successor, BsonDocument physicalModel)
    {
        if (physicalModel.GetValue("Enabled", BsonNull.Value) is not { IsBoolean: true } enabled || !enabled.AsBoolean) return false;
        var type = logical.GetStringOrEmpty("ModelType");
        var required = LogicalModelCapabilityPolicy.Normalize(type, Strings(logical, "Capabilities"));
        var declared = LogicalModelCapabilityPolicy.Normalize(type, successor.Capabilities);
        var physical = PhysicalCapabilities(physicalModel, type);
        return required.All(declared.Contains) && required.All(physical.Contains);
    }
    public static decimal? ValidationEstimate(BsonDocument model, string modelType)
    {
        if (model.AsNullableString("PriceCurrency")?.ToUpperInvariant() != "USD"
            || PricingPolicy.IsStale(model.AsNullableUtcDateTime("PriceObservedAt"), DateTime.UtcNow)) return null;
        if (model.AsNullableDecimal("PricePerCall") is >= 0m and var perCall) return perCall;
        if (modelType != "chat") return null;
        var input = model.AsNullableDecimal("InputPricePerMillion");
        var output = model.AsNullableDecimal("OutputPricePerMillion");
        return input is >= 0 && output is >= 0 ? (input.Value * 256 + output.Value * 32) / 1_000_000m : null;
    }
    public static bool HasKnownPrice(BsonDocument model)
        => model.AsNullableString("PriceCurrency")?.ToUpperInvariant() == "USD"
           && !PricingPolicy.IsStale(model.AsNullableUtcDateTime("PriceObservedAt"), DateTime.UtcNow)
           && (model.AsNullableDecimal("PricePerCall") is >= 0
               || model.AsNullableDecimal("InputPricePerMillion") is >= 0 && model.AsNullableDecimal("OutputPricePerMillion") is >= 0);
    public static bool PricePass(BsonDocument current, BsonDocument candidate, string type, decimal? maxIncrease)
    {
        if (!HasKnownPrice(current) || !HasKnownPrice(candidate) || maxIncrease is null) return false;
        var multiplier = 1 + maxIncrease.Value / 100m;
        if (current.AsNullableDecimal("PricePerCall") is { } oldCall && candidate.AsNullableDecimal("PricePerCall") is { } newCall)
            return newCall <= oldCall * multiplier;
        return current.AsNullableDecimal("PricePerCall") is null && candidate.AsNullableDecimal("PricePerCall") is null
            && candidate.AsNullableDecimal("InputPricePerMillion") <= current.AsNullableDecimal("InputPricePerMillion") * multiplier
            && candidate.AsNullableDecimal("OutputPricePerMillion") <= current.AsNullableDecimal("OutputPricePerMillion") * multiplier;
    }
    public static bool BudgetPass(ModelUpgradeState state, decimal? estimate, DateTime now)
        => estimate is not null && state.Policy.MaxValidationCostUsd is { } single && estimate <= single
           && state.Policy.MaxDailyCostUsd is { } daily
           && (state.BudgetDate == now.ToString("yyyy-MM-dd") ? state.ReservedCostUsd : 0) + estimate <= daily;
    public static bool CanPromote(ModelUpgradeState s, bool automatic, DateTime now)
        => !s.OutcomeUnknown && s.Candidate?.ValidatedAt is { } at && at > now.AddHours(-24)
           && s.Gates.Capabilities && s.Gates.Validation && (!automatic || s.Gates.Price && s.Gates.Budget);
    public static string Fingerprint(BsonDocument logical, BsonDocument provider, BsonDocument model)
    {
        var snapshot = new BsonArray(new[] { logical, provider, model }.Select(d =>
            new BsonDocument { { "id", d.GetValue("_id", "") }, { "updatedAt", d.GetValue("UpdatedAt", BsonNull.Value) } }));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(snapshot.ToJson()))).ToLowerInvariant();
    }

    public static bool EvidencePasses(BsonDocument log, string tenantId, ModelUpgradeCandidate c, string modelType)
        => log.GetStringOrEmpty("TenantId") == tenantId && log.GetStringOrEmpty("PlatformId") == c.ProviderId
           && log.GetStringOrEmpty("Model") == c.UpstreamModelId && log.GetStringOrEmpty("Status") == "succeeded"
           && log.AsNullableInt("StatusCode") is >= 200 and < 300 && log.AsNullableUtcDateTime("EndedAt") is { } end
           && end > DateTime.UtcNow.AddHours(-24)
           && (modelType == "generation" ? log.AsNullableInt("ImageSuccessCount") > 0
               || log.GetValue("OutputImages", BsonNull.Value) is BsonArray { Count: > 0 }
               : log.AsNullableInt("OutputTokens") > 0 && !string.IsNullOrWhiteSpace(log.AsNullableString("AnswerText")));
}
