using System.Text.Json;

namespace PrdAgent.Core.LlmGateway;

/// <summary>仅依据上游错误契约归因；HTTP 403/429 本身不能证明欠费。</summary>
public sealed record GatewayBillingFailure(string Code, string Reason, string RecoveryAction)
{
    public const string AccountOverdue = "LLM_ACCOUNT_OVERDUE";
    public const string InsufficientBalance = "LLM_INSUFFICIENT_BALANCE";
    public const string QuotaExceeded = "LLM_QUOTA_EXCEEDED";
    public const string PaymentRequired = "LLM_PAYMENT_REQUIRED";

    public string UserMessage => $"上游 AI 服务{Reason}，本次操作未完成。{RecoveryAction}处理后再重试。";

    public static GatewayBillingFailure? FromCode(string? code) => code?.ToUpperInvariant() switch
    {
        AccountOverdue => new(AccountOverdue, "账户欠费", "请联系管理员补缴费用或切换可用线路，"),
        InsufficientBalance => new(InsufficientBalance, "账户余额不足", "请联系管理员补充余额或切换可用线路，"),
        QuotaExceeded => new(QuotaExceeded, "可用额度已用尽或达到用量上限", "管理员需要检查服务额度或切换可用配置，"),
        PaymentRequired => new(PaymentRequired, "因账单或费用额度限制拒绝请求", "请联系管理员核对账单和费用额度，"),
        _ => null,
    };

    public static GatewayBillingFailure? Classify(int? statusCode, string? diagnostic, string? errorCode = null)
    {
        if (FromCode(errorCode) is { } known) return known;

        var message = diagnostic ?? string.Empty;
        // 老任务可能只保存已净化的文案；只认本系统完整句子，不在任意文本里猜账单原因。
        if (statusCode == null)
            foreach (var kind in new[] { AccountOverdue, InsufficientBalance, QuotaExceeded, PaymentRequired })
            {
                var canonical = FromCode(kind)!;
                if (message.Trim() == canonical.UserMessage) return canonical;
            }
        string? code = errorCode, type = null, limitSource = null;
        if (message.TrimStart().StartsWith('{'))
        {
            try
            {
                using var doc = JsonDocument.Parse(message, new JsonDocumentOptions { MaxDepth = 32 });
                var error = Property(doc.RootElement, "error") ?? doc.RootElement;
                code = Text(error, "code") ?? Text(error, "errorCode") ?? code;
                type = Text(error, "type");
                var metadata = Property(error, "metadata");
                if (metadata is { } value) limitSource = Text(value, "limit_source");
                // 不在任意 JSON 字符串（如回显提示词、日志链接）里搜索欠费关键词。
                message = error.ValueKind == JsonValueKind.String ? error.GetString() ?? ""
                    : Text(error, "message") ?? Text(error, "errorMessage") ?? "";
            }
            catch (JsonException) { return statusCode == 402 ? FromCode(PaymentRequired) : null; }
        }

        if (string.Equals(limitSource, "openrouter_in_flight_budget", StringComparison.OrdinalIgnoreCase)) return null;
        if (string.Equals(limitSource, "openrouter_key_limit", StringComparison.OrdinalIgnoreCase)) return FromCode(QuotaExceeded);
        var upstreamCode = (code ?? "").ToLowerInvariant();
        var specific = upstreamCode switch
        {
            "accountoverdue" or "accountoverdueerror" or "operationdenied.serviceoverdue" => AccountOverdue,
            "insufficient_balance" or "credit_balance_exhausted" => InsufficientBalance,
            "insufficient_quota" or "organization_usage_limit_exceeded" => QuotaExceeded,
            _ => null,
        };
        if (specific != null) return FromCode(specific);
        if (upstreamCode is "rate_limit_exceeded" or "slow_down" or "accessdenied") return null;
        if (statusCode is not (null or 402 or 403 or 429)) return null;
        var m = message.ToLowerInvariant();
        if (m.Contains("overdue balance") || m.Contains("account balance is overdue")
            || m.Contains("账户欠费") || m.Contains("账号欠费")) return FromCode(AccountOverdue);
        if (m.Contains("insufficient balance") || m.Contains("insufficient credits")
            || m.Contains("credit balance is too low") || m.Contains("余额不足")) return FromCode(InsufficientBalance);
        if (m.Contains("rate limit") || m.Contains("rate-limit") || m.Contains("requests per")
            || m.Contains("per minute") || m.Contains("too many requests")) return null;
        if (string.Equals(type, "insufficient_quota", StringComparison.OrdinalIgnoreCase)
            || m.Contains("user quota is not enough") || m.Contains("key limit exceeded")
            || m.Contains("credit limit exceeded") || m.Contains("exceeded your current quota")
            || m.Contains("额度已用尽") || m.Contains("额度用尽")) return FromCode(QuotaExceeded);
        return statusCode == 402 ? FromCode(PaymentRequired) : null;
    }

    private static JsonElement? Property(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        foreach (var property in element.EnumerateObject())
            if (property.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) return property.Value;
        return null;
    }

    private static string? Text(JsonElement element, string name)
        => Property(element, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;
}

/// <summary>供 MAP 管理提醒消费的有限字段，不包含原始响应、密钥或供应商控制台链接。</summary>
public sealed record GatewayBillingAlert(string ErrorCode, string? PlatformName, string? ModelName);
