using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>移除来源线路时保留公开模型身份，并保护仍被业务使用的最后一条可用线路。</summary>
public static class OfferingRemovalPolicy
{
    public readonly record struct Rejection(string Code, string Message);

    public static Rejection? Evaluate(BsonDocument logical, BsonDocument offering,
        bool hasUsableAlternative, bool referencedByMap, bool hasInFlightJobs)
    {
        if (offering.AsNullableBool("Enabled") != false)
            return new("OFFERING_MUST_BE_DISABLED", "请先停用这条线路，再移除；公开模型名称和 MAP 中的显示名称会保留。");
        if (hasInFlightJobs)
            return new("OFFERING_HAS_INFLIGHT_JOBS", "这条线路或公开模型还有未完成或保留期内的任务。请等待任务结束、取消或保留期到期后再移除。");
        var catchesTraffic = logical.AsNullableBool("Enabled") != false
            || logical.AsNullableBool("IsDefaultForType") == true
            || logical.GetValue("DefaultForAppCallerCodes", BsonNull.Value) is BsonArray { Count: > 0 }
            || referencedByMap;
        if (catchesTraffic && !hasUsableAlternative)
            return new("OFFERING_LAST_USABLE_ROUTE", "这个公开模型仍启用或被 MAP、默认配置引用，尚无其他可用线路。请先接入并验证同一模型的替代线路；不要删除公开模型或取消画师、日光等业务配置。");
        return null;
    }

    public static bool HasUsableAlternative(string removedId, IReadOnlyCollection<BsonDocument> offerings,
        IReadOnlyCollection<BsonDocument> models, IReadOnlyCollection<BsonDocument> platforms,
        IReadOnlyCollection<BsonDocument> exchanges)
    {
        foreach (var route in offerings)
        {
            if (route.GetStringOrEmpty("_id") == removedId || route.Contains("SupersededByOfferingId")
                || route.AsNullableBool("Enabled") != true || route.AsNullableInt("HealthStatus") is not (0 or 1)) continue;
            var kind = route.AsNullableString("TargetKind") ?? "model";
            if (kind is not ("model" or "exchange")) continue;
            var targetId = route.GetStringOrEmpty("TargetId");
            var target = (kind == "model" ? models : exchanges).FirstOrDefault(x => x.GetStringOrEmpty("_id") == targetId);
            var platformId = target?.AsNullableString("PlatformId");
            var platform = platforms.FirstOrDefault(x => x.GetStringOrEmpty("_id") == platformId);
            if (OfferingTargetEligibility.Evaluate(kind, target, platform, route.AsNullableString("UpstreamModelId")) is not null) continue;
            // 删除闸保守使用严格名录门；它不能把数据面会拒绝的线路计作替代。
            if (kind == "exchange")
            {
                if (CatalogGatePolicy.ExchangeRoutePasses(target!, route.AsNullableString("UpstreamModelId"), true)) return true;
                continue;
            }
            var effectiveModel = route.AsNullableString("UpstreamModelId") is { Length: > 0 } name
                ? name.Trim() : target!.GetStringOrEmpty("ModelName");
            var sameName = models.Where(x => x.AsNullableString("PlatformId") == platformId
                && string.Equals(x.AsNullableString("ModelName"), effectiveModel, StringComparison.OrdinalIgnoreCase)).ToList();
            if (CatalogGatePolicy.PhysicalRoutePasses(effectiveModel, sameName, true)) return true;
        }
        return false;
    }

    /// <summary>只删除刚读到的停用快照；启用或编辑过后条件不再匹配。</summary>
    public static FilterDefinition<BsonDocument> UnchangedDisabledFilter(BsonDocument offering)
    {
        var fb = Builders<BsonDocument>.Filter;
        return fb.And(fb.Eq("_id", offering.GetStringOrEmpty("_id")),
            fb.Eq("TenantId", offering.GetStringOrEmpty("TenantId")),
            fb.Eq("LogicalModelId", offering.GetStringOrEmpty("LogicalModelId")), fb.Eq("Enabled", false),
            offering.Contains("UpdatedAt") ? fb.Eq("UpdatedAt", offering["UpdatedAt"]) : fb.Exists("UpdatedAt", false));
    }
}
