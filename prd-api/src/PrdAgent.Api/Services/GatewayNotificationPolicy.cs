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
        var requestFailed = signal.RequestOutcome is "request_failed" or "all_failed"
            || signal.FailureObservations.Any(item => item.Outcome is "request_failed" or "all_failed");
        if (signal.FailureCategory is Quota or "access")
            return requestFailed ? "error" : "warning";
        if (signal.DistinctRecentFailedRequests < 3)
            return "info";
        return requestFailed && signal.FailureCategory != RateLimit ? "error" : "warning";
    }

    internal static int LevelRank(string? level) => level switch { "error" => 2, "warning" => 1, _ => 0 };

    internal static string? EnvironmentLabel(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "production" or "prod" or "正式" or "正式环境" or "生产" => "正式",
        "staging" or "preproduction" or "预发" or "灰度" => "预发",
        "test" or "testing" or "测试" => "测试",
        "preview" or "branch-preview" or "分支预览" => "分支预览",
        "local" or "development" or "dev" or "本地" => "本地",
        _ => null,
    };

    internal static string? OutcomeIcon(AdminNotification notification)
    {
        if (notification.Level == "success") return "recovery";
        return notification.Level == "error" || notification.IncidentState == "active"
            || notification.IncidentId is not null && notification.IncidentState == "recovered"
            || notification.IncidentCategory == "policy-block" ? "failure" : null;
    }

    internal static bool AllowsPush(AdminNotification notification)
        => !Source.Equals(notification.Source?.Trim(), StringComparison.OrdinalIgnoreCase)
           || notification.IncidentState != "recovered" && LevelRank(notification.Level) > 0;
}
