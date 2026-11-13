namespace PrdAgent.GatewayTransport;

/// <summary>共享上游额度判据；429 只有带明确额度信号才算余额或额度不足。</summary>
public static class UpstreamQuotaPolicy
{
    public static bool IsExceeded(int statusCode, string? rawMessage)
    {
        var m = (rawMessage ?? string.Empty).ToLowerInvariant();

        // 限流（节流）排除：只把「文本明确指向速率/每分钟请求数」的失败排除掉，不能用「429 一律 false」短路——
        // 部分供应商（如 OpenAI insufficient_quota）也用 429 返回额度耗尽，需让后面的 quota/credit/balance 文本判定
        // 继续生效，否则这些额度失败会走泛化 LLM_ERROR、漏掉额度告警（Codex review）。
        // "Rate limit exceeded" 含 "limit exceeded" 子串，由下面的 rate-limit 文本判定先行排除，不会误判为额度。
        if (m.Contains("rate limit") || m.Contains("rate-limit")
            || m.Contains("requests per") || m.Contains("per minute")
            || m.Contains("too many requests"))
            return false;

        if (statusCode == 402) return true; // Payment Required = 额度/账单
        if (m.Length == 0) return false;

        // 只认明确指向「额度/余额/账单/key 限额」的信号；裸 "limit exceeded" 不再单独判定为额度。
        return m.Contains("quota is not enough")                    // APIyi 403：user quota is not enough
            || m.Contains("key limit")                                   // OpenRouter "Key limit exceeded"
            || m.Contains("credit limit")
            || (m.Contains("limit exceeded") && (m.Contains("credit") || m.Contains("quota") || m.Contains("balance") || m.Contains("key")))
            || (m.Contains("quota") && (m.Contains("exceed") || m.Contains("insufficient")))
            || (m.Contains("insufficient") && (m.Contains("credit") || m.Contains("balance")))
            || m.Contains("exceeded your current")
            || (m.Contains("billing") && m.Contains("limit"));
    }

}
