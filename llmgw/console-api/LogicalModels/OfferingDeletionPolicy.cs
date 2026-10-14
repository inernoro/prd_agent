using MongoDB.Bson;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>
/// 删除一条 Offering 后，逻辑模型是否还保有至少一条能承接新请求的线路。
/// 历史日志不参与；停用、被替代或目标不可用的线路也不能拿来充数。
/// </summary>
public static class OfferingDeletionPolicy
{
    public static bool HasUsableRemaining(
        IEnumerable<BsonDocument> candidates,
        IReadOnlyDictionary<string, BsonDocument> modelTargets,
        IReadOnlyDictionary<string, BsonDocument> exchangeTargets,
        IReadOnlyDictionary<string, BsonDocument> platformTargets)
        => candidates.Any(candidate =>
        {
            if (candidate.AsNullableBool("Enabled") != true
                || candidate.Contains("SupersededByOfferingId"))
            {
                return false;
            }

            var targetKind = candidate.GetStringOrEmpty("TargetKind");
            var targetId = candidate.GetStringOrEmpty("TargetId");
            var target = targetKind == "model"
                ? modelTargets.GetValueOrDefault(targetId)
                : exchangeTargets.GetValueOrDefault(targetId);
            var platform = targetKind == "model" && target?.AsNullableString("PlatformId") is { Length: > 0 } platformId
                ? platformTargets.GetValueOrDefault(platformId)
                : null;

            return OfferingTargetEligibility.Evaluate(
                targetKind,
                target,
                platform,
                candidate.AsNullableString("UpstreamModelId")) is null;
        });
}
