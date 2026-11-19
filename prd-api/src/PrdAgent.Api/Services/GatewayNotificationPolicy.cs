using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>用已确认的故障类型、请求影响和重复证据决定提醒强度。</summary>
internal static class GatewayNotificationPolicy
{
    internal const string Source = "gateway-alert";
    internal const string RateLimit = "rate-limit";
    internal const string Quota = "quota";
    internal static readonly TimeSpan RepetitionWindow = TimeSpan.FromMinutes(5);

    internal static string FailureLevel(LlmGatewayIncidentSignal signal)
    {
        var requestFailed = signal.RequestOutcome is "request_failed" or "all_failed";
        if (signal.FailureCategory is Quota or "access")
            return requestFailed ? "error" : "warning";
        if (signal.DistinctRecentFailedRequests < 3)
            return "info";
        return requestFailed && signal.FailureCategory != RateLimit ? "error" : "warning";
    }

    internal static int LevelRank(string? level) => level switch { "error" => 2, "warning" => 1, _ => 0 };

    internal static bool AllowsPush(AdminNotification notification)
        => !Source.Equals(notification.Source?.Trim(), StringComparison.OrdinalIgnoreCase)
           || notification.IncidentState != "recovered" && LevelRank(notification.Level) > 0;
}
