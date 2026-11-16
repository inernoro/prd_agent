using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.ModelUpgrades;

public sealed partial class ModelUpgradeService
{
    private async Task<BsonDocument> ReadValidatedRouteAsync(ModelUpgradeState s, BsonDocument logical, BsonDocument provider, BsonDocument model)
    {
        var snapshot = s.Candidate?.ValidationRoute ?? throw new ModelUpgradeException("CANDIDATE_WIRE_REQUIRED", "候选缺少已验收线路身份，请改用受控验收，不能把旧日志当作当前线路已验证。");
        var route = await RequiredAsync(Offerings, s.TenantId, snapshot.OfferingId);
        var sourceLogical = await LogicalAsync(s.TenantId, snapshot.LogicalModelId);
        if (!ModelUpgradeRules.IsFixedValidationTarget(sourceLogical, logical.GetStringOrEmpty("ModelType"))
            || !ModelUpgradeWire.Matches(snapshot, route, model, provider))
            throw new ModelUpgradeException("CANDIDATE_WIRE_CHANGED", "已验收的候选固定线路已变化，请重新验收；稳定线路未修改。");
        return route;
    }
    private async Task CaptureEvidenceWireAsync(ModelUpgradeState s, BsonDocument logical, BsonDocument provider, BsonDocument model, List<BsonDocument> evidence)
    {
        foreach (var log in evidence)
        {
            var id = log.AsNullableString("OfferingId");
            if (string.IsNullOrWhiteSpace(id)) continue;
            var route = await Offerings.Find(Scope(s.TenantId, F.Eq("_id", id))).FirstOrDefaultAsync(CancellationToken.None);
            if (route is null) continue;
            var sourceLogical = await Logicals.Find(Scope(s.TenantId, F.Eq("_id", route.GetStringOrEmpty("LogicalModelId")))).FirstOrDefaultAsync(CancellationToken.None);
            if (sourceLogical is null || !ModelUpgradeRules.IsFixedValidationTarget(sourceLogical, logical.GetStringOrEmpty("ModelType"))) continue;
            ModelUpgradeRouteSnapshot snapshot;
            try { snapshot = ModelUpgradeWire.Capture(route, model, provider); }
            catch (ModelUpgradeException) { continue; }
            if (!ModelUpgradeWire.LogMatches(snapshot, log)) continue;
            s.Candidate!.ValidationRoute = snapshot;
            return;
        }
        throw new ModelUpgradeException("EVIDENCE_WIRE_REQUIRED", "该证据缺少可匹配的固定线路身份、协议或路径，不能认定当前线路已验收；请改用受控验收。");
    }
}
