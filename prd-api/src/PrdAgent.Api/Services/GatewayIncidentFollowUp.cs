using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

internal static class GatewayIncidentFollowUp
{
    internal const string IncidentKeyPrefix = "llmgw-upstream:";
    internal const string RecoveryKeyPrefix = "llmgw-upstream-recovered:";
    private const int EvidenceLimit = 24;

    internal static bool IsTracked(AdminNotification item) => item.Source == GatewayNotificationPolicy.Source
        && item.TargetUserId is null && !string.IsNullOrWhiteSpace(item.IncidentId)
        && item.IncidentState is "active" or "recovered"
        && (item.Key == IncidentKeyPrefix + item.IncidentId
            || item.Key?.StartsWith(RecoveryKeyPrefix + item.IncidentId + ":", StringComparison.Ordinal) == true);

    internal static long Episode(AdminNotification item) => item.IncidentEpisode ?? item.PushEpisode;

    internal static List<GatewayIncidentEvidence> ReadEvidence(AdminNotification item)
    {
        if (item.IncidentEvidence is { Count: > 0 }) return item.IncidentEvidence;
        if (string.IsNullOrWhiteSpace(item.EvidenceRequestId)) return [];
        var recovered = item.IncidentState == "recovered";
        var at = recovered ? item.RecoveredAt : item.LastOccurredAt;
        return at.HasValue ? [Create(item.EvidenceRequestId, item.EvidenceRequestId,
            recovered ? "recovered" : item.RequestOutcome, at.Value)] : [];
    }

    internal static List<GatewayIncidentEvidence> RecordFailures(AdminNotification? previous,
        LlmGatewayIncidentSignal signal, IEnumerable<LlmGatewayFailureObservation> observations)
    {
        var entries = observations.Where(x => !string.IsNullOrWhiteSpace(x.RequestId))
            .Select(x => Create(x.RequestId!, x.RequestKey, x.Outcome, x.At)).ToList();
        if (entries.All(x => x.RequestId != signal.RequestId))
            entries.Add(Create(signal.RequestId, signal.FailureObservations.LastOrDefault(x => x.RequestId == signal.RequestId)?.RequestKey,
                signal.RequestOutcome, signal.ObservedAt));
        if (previous is not null) entries.InsertRange(0, ReadEvidence(previous));
        var sorted = entries.GroupBy(x => x.RequestId, StringComparer.Ordinal).Select(ConfirmedOrLatest)
            .GroupBy(x => x.RequestKey, StringComparer.Ordinal).Select(ConfirmedOrLatest)
            .OrderBy(x => x.ObservedAt).ThenBy(x => x.RequestId, StringComparer.Ordinal).ToList();
        if (sorted.Count <= EvidenceLimit) return sorted;

        // 优先保留每种结果的第一条证据，其余保留最近请求，给恢复观测预留一个位置。
        var firstOfEach = sorted.DistinctBy(x => x.Outcome).ToList();
        return firstOfEach.Concat(sorted.Except(firstOfEach).TakeLast(EvidenceLimit - firstOfEach.Count))
            .OrderBy(x => x.ObservedAt).ThenBy(x => x.RequestId, StringComparer.Ordinal).ToList();
    }

    internal static List<GatewayIncidentEvidence> RecordRecovery(AdminNotification item, LlmGatewayIncidentSignal signal)
    {
        var recovery = Create(signal.RequestId, null, "recovered", signal.ObservedAt);
        recovery.RouteLabel = signal.IsGatewayEntry ? $"{signal.AppCallerLabel} · 调用入口" : $"{signal.PlatformLabel} · {signal.ModelLabel}";
        return [.. ReadEvidence(item), recovery];
    }

    internal static string RequestUrl(string requestId) => $"/logs?requestId={Uri.EscapeDataString(requestId)}";

    private static GatewayIncidentEvidence ConfirmedOrLatest(IEnumerable<GatewayIncidentEvidence> entries)
    {
        var sorted = entries.OrderBy(x => x.ObservedAt).ToList();
        return sorted.LastOrDefault(x => x.Outcome != "unknown") ?? sorted[^1];
    }

    private static GatewayIncidentEvidence Create(string requestId, string? requestKey, string? outcome, DateTime at) => new()
    {
        RequestId = requestId,
        RequestKey = string.IsNullOrWhiteSpace(requestKey) ? requestId : requestKey,
        Outcome = outcome is "request_failed" or "all_failed" or "fallback_succeeded" or "recovered" ? outcome : "unknown",
        ObservedAt = at,
    };
}
