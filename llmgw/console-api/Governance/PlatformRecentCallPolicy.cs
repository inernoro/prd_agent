using MongoDB.Bson;
using PrdAgent.GatewayTransport;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.Governance;

/// <summary>最近真实请求的观测，不是实时余额查询；配置变化前的记录不能归到当前密钥。</summary>
public static class PlatformRecentCallPolicy
{
    public static string? Classify(BsonDocument? log, DateTime? configurationUpdatedAt)
    {
        if (log is null || log.AsNullableUtcDateTime("StartedAt") is not { } started
            || configurationUpdatedAt is { } updated && started < updated) return null;
        var status = log.AsNullableInt("StatusCode") ?? 0;
        var error = log.AsNullableString("Error");
        if (UpstreamQuotaPolicy.IsExceeded(status, error)) return "quota_exhausted";
        if (status == 429) return "rate_limited";
        if (status is 401 or 403) return "rejected";
        if (status >= 500) return "service_error";
        if (log.AsNullableString("Status") == "succeeded" && status is >= 200 and < 300) return "succeeded";
        return "failed";
    }
}
