using MongoDB.Bson;
using MongoDB.Driver;
using System.Text.Json;
using PrdAgent.GatewayTransport;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.ModelUpgrades;

public sealed partial class ModelUpgradeService
{
    private static readonly TimeSpan TrafficCheckInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan TrafficStageLimit = TimeSpan.FromHours(10);

    private async Task StartTrafficTrialAsync(ModelUpgradeState state)
    {
        var now = DateTime.UtcNow;
        var candidate = state.Candidate;
        if (!ModelUpgradeRules.UsesTrafficTrial(state.Policy) || !state.Policy.Enabled || state.Policy.Mode != "auto" || candidate is null
            || !ModelUpgradeRules.TapdSmokePasses(candidate, now) || !state.Gates.Price || !state.Gates.Budget
            || state.Current is null || candidate.ValidationRoute is not { } route
            || configuration?[ModelUpgradeDeploymentAuthority.WorkerDeploymentKey] is not { Length: > 0 } deployment)
            throw new ModelUpgradeException("TRAFFIC_TRIAL_NOT_READY", "候选尚未达到 TAPD 灰度试用条件。");

        var (logical, provider, model) = await CandidateAsync(state);
        if (!IsPilotLogical(logical)) throw new ModelUpgradeException("TAPD_PILOT_SCOPE", "灰度需要 TAPD 草稿专用稳定模型，且未被设为全局默认。");
        await ReadValidatedRouteAsync(state, logical, provider, model);
        state.TrafficTrial = new() { Deployment = deployment, BaselineOfferingId = state.Current.OfferingId,
            CandidateOfferingId = route.OfferingId, CandidateOfferingVersion = route.OfferingVersion,
            StartedAt = now, ExpiresAt = now + TrafficStageLimit };
        state.NextTrafficCheckAt = now + TrafficCheckInterval;
        state.Phase = "trial";
        state.Message = "候选通过 48 小时冒烟观察，开始接收 5% 的 TAPD 草稿用户。";
    }

    private static bool IsPilotLogical(BsonDocument logical)
        => logical.GetStringOrEmpty("ModelType") == "chat" && !logical.GetValue("IsDefaultForType", false).ToBoolean()
           && ModelUpgradeRules.Strings(logical, "AllowedAppCallerCodes") is [var caller]
           && string.Equals(caller, ModelRotationRouting.PilotCaller, StringComparison.OrdinalIgnoreCase);

    private async Task PollTrafficTrialAsync(ModelUpgradeState state, CancellationToken ct)
    {
        var trial = state.TrafficTrial!;
        var now = DateTime.UtcNow;
        try
        {
            var (logical, provider, model) = await CandidateAsync(state);
            var current = await CurrentAsync(state.TenantId, state.LogicalModelId);
            var route = await ReadValidatedRouteAsync(state, logical, provider, model);
            if (!IsPilotLogical(logical) || current?.OfferingId != trial.BaselineOfferingId
                || ModelUpgradeWire.Fingerprint(route) != trial.CandidateOfferingVersion)
                throw new ModelUpgradeException("TRAFFIC_ROUTE_CHANGED", "灰度线路或权限发生变化，已停止向候选分流。");
            if (route.AsNullableInt("HealthStatus") is > 0)
            {
                StopTrafficTrial(state, "候选线路健康状态下降，所有新请求恢复现任模型。");
                return;
            }

            var baseline = await ReadTrafficAsync(state, trial.BaselineOfferingId, trial.StartedAt, ct);
            var candidate = await ReadTrafficAsync(state, trial.CandidateOfferingId, trial.StartedAt, ct);
            var verdict = CompareTraffic(baseline, candidate);
            if (verdict == "regression" || now >= trial.ExpiresAt)
            {
                StopTrafficTrial(state, verdict == "regression" ? "候选实测退化，流量已退回现任模型。" : "本档未取得足够的真实数据，流量已退回现任模型。");
                return;
            }
            if (now - trial.StartedAt >= TimeSpan.FromHours(1) && verdict == "pass")
            {
                if (trial.Percentage == 5)
                {
                    trial.Percentage = 25;
                    trial.StartedAt = now;
                    trial.ExpiresAt = now + TrafficStageLimit;
                }
                else
                {
                    state.TrafficTrial = null;
                    state.NextTrafficCheckAt = null;
                    state.Candidate!.TrafficTrialPassedAt = now;
                    state.PendingAction = "promote";
                    state.Phase = "promoting";
                    state.Message = "两档真实流量对照均通过，等待切换默认线路。";
                    return;
                }
            }
            state.NextTrafficCheckAt = now + TrafficCheckInterval;
            state.Message = $"灰度 {trial.Percentage}% 持续观察中，本轮现任 {baseline.Count} 次，候选 {candidate.Count} 次。";
        }
        catch (ModelUpgradeException)
        {
            StopTrafficTrial(state, "灰度线路或验收证据发生变化，流量已退回现任模型。");
            throw;
        }
    }

    private static void StopTrafficTrial(ModelUpgradeState state, string message)
    {
        state.TrafficTrial = null;
        state.NextTrafficCheckAt = null;
        if (state.Candidate is { } candidate)
        {
            candidate.BusinessSmokeRejected = true;
            candidate.TrafficTrialPassedAt = null;
        }
        state.Phase = "blocked";
        state.Message = message;
    }

    private async Task WatchPromotedTrafficAsync(ModelUpgradeState state, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        if (state.TrafficWatchStartedAt is not { } since || state.LastPromotion is not { RolledBack: false } promotion)
        {
            state.TrafficWatchStartedAt = null;
            state.NextTrafficCheckAt = null;
            return;
        }
        var current = await CurrentAsync(state.TenantId, state.LogicalModelId);
        if (current?.OfferingId != promotion.NewOfferingId)
        {
            state.TrafficWatchStartedAt = null;
            state.NextTrafficCheckAt = null;
            throw new ModelUpgradeException("TRAFFIC_ROUTE_CHANGED", "当前默认线路已发生变化，结束本轮自动监控。");
        }
        var samples = await ReadTrafficAsync(state, promotion.NewOfferingId, since, ct);
        if (SevereFailure(samples.Take(20).ToList()))
        {
            await SwitchAsync(state, true);
            state.Message = "接棒后错误率严重退化，已自动恢复上一条可用线路。";
            return;
        }
        state.NextTrafficCheckAt = now < since.AddHours(48) ? now + TrafficCheckInterval : null;
        if (state.NextTrafficCheckAt is null) state.TrafficWatchStartedAt = null;
    }

    private async Task<List<ModelRotationObservation>> ReadTrafficAsync(ModelUpgradeState state, string offeringId, DateTime since, CancellationToken ct)
    {
        var rows = await Logs.Find(Scope(state.TenantId, F.And(F.Eq("AppCallerCode", ModelRotationRouting.PilotCaller),
                F.Eq("LogicalModelId", state.LogicalModelId), F.Eq("OfferingId", offeringId), F.Gte("StartedAt", since),
                F.In("Status", new[] { "succeeded", "failed" }))))
            .Sort(Builders<BsonDocument>.Sort.Descending("StartedAt")).Limit(500).ToListAsync(ct);
        return rows.Where(row => row.GetStringOrEmpty("RequestId").Length > 0)
            .DistinctBy(row => row.GetStringOrEmpty("RequestId"), StringComparer.Ordinal)
            .Select(row => new ModelRotationObservation(row.GetStringOrEmpty("Status") == "succeeded"
                && HasStructuredDraft(row.GetStringOrEmpty("AnswerText")), row.AsNullableInt("DurationMs"), row.AsNullableDecimal("EstimatedCostUsd"))).ToList();
    }

    private static bool HasStructuredDraft(string answer)
    {
        var start = answer.IndexOf('{');
        var end = answer.LastIndexOf('}');
        if (start < 0 || end <= start) return false;
        try
        {
            using var parsed = JsonDocument.Parse(answer[start..(end + 1)]);
            var draft = parsed.RootElement;
            return draft.ValueKind == JsonValueKind.Object && draft.TryGetProperty("title", out var title)
                && title.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(title.GetString())
                && new[] { "preconditions", "steps", "actualResult", "expectedResult" }.All(name =>
                    draft.TryGetProperty(name, out var lines) && lines.ValueKind == JsonValueKind.Array && lines.GetArrayLength() > 0
                    && lines.EnumerateArray().All(line => line.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(line.GetString())));
        }
        catch (JsonException) { return false; }
    }

    internal sealed record ModelRotationObservation(bool Success, int? DurationMs, decimal? CostUsd);

    internal static string CompareTraffic(IReadOnlyList<ModelRotationObservation> baseline, IReadOnlyList<ModelRotationObservation> candidate)
    {
        var failures = candidate.Count(row => !row.Success);
        if (SevereFailure(candidate)) return "regression";
        if (baseline.Count < 20 || candidate.Count < 20) return "waiting";
        var errorDelta = (double)failures / candidate.Count - (double)baseline.Count(row => !row.Success) / baseline.Count;
        if (errorDelta > .05) return "regression";
        var left = baseline.Where(row => row.Success).ToList();
        var right = candidate.Where(row => row.Success).ToList();
        if (left.Count < 15 || right.Count < 15 || left.Concat(right).Any(row => row.DurationMs is null or <= 0 || row.CostUsd is null or < 0)) return "waiting";
        var latencyRatio = (double)P95(right) / P95(left);
        var cost = left.Average(row => row.CostUsd!.Value);
        var candidateCost = right.Average(row => row.CostUsd!.Value);
        if (latencyRatio > 1.2 || candidateCost > cost * 1.1m) return "regression";
        return errorDelta <= .02 && (latencyRatio <= .9 || cost > 0 && candidateCost <= cost * .9m || errorDelta <= -.05) ? "pass" : "waiting";
    }

    private static int P95(List<ModelRotationObservation> samples)
        => samples.Select(row => row.DurationMs!.Value).Order().ElementAt((int)Math.Ceiling(samples.Count * .95) - 1);

    private static bool SevereFailure(IReadOnlyList<ModelRotationObservation> samples)
    {
        var failed = samples.Count(row => !row.Success);
        return samples.Count >= 5 && failed >= 3 && failed * 5 >= samples.Count;
    }
}
