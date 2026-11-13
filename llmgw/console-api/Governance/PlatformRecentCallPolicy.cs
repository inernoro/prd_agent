using MongoDB.Bson;
using PrdAgent.GatewayTransport;
using PrdAgent.LlmGw.Mongo;
using System.Text.Json;

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
        // 图片原始调用把上游错误响应存进 AnswerText，Error 可能为空。
        // 只读取标准 error 对象的诊断字段，不在任意回复或回显提示词中搜索。
        if (log.AsNullableString("Status") == "failed" && log.AsNullableString("AnswerText") is { } answer)
        {
            try
            {
                using var json = JsonDocument.Parse(answer, new JsonDocumentOptions { MaxDepth = 32 });
                if (json.RootElement.ValueKind == JsonValueKind.Object && json.RootElement.TryGetProperty("error", out var detail)
                    && detail.ValueKind == JsonValueKind.Object)
                {
                    var code = Text(detail, "code");
                    if (code is "credit_balance_exhausted" or "insufficient_balance" or "insufficient_quota"
                        or "insufficient_user_quota" or "organization_usage_limit_exceeded") return "quota_exhausted";
                    if (string.IsNullOrWhiteSpace(error)) error = Text(detail, "message");
                }
            }
            catch (JsonException) { /* 不完整历史响应不据此推断额度。 */ }
        }
        if (UpstreamQuotaPolicy.IsExceeded(status, error)) return "quota_exhausted";
        if (status == 429) return "rate_limited";
        if (status is 401 or 403) return "rejected";
        if (status >= 500) return "service_error";
        if (log.AsNullableString("Status") == "succeeded" && status is >= 200 and < 300) return "succeeded";
        return "failed";
    }

    private static string? Text(JsonElement value, string name)
        => value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;
}
