namespace PrdAgent.Core.LlmGateway;

/// <summary>
/// 一笔金额的证据性质。它回答“这个数从哪里来”，不改变计费公式或路由。
/// </summary>
public static class GatewayCostKind
{
    /// <summary>供应商响应或账单给出的实际金额。</summary>
    public const string ProviderActual = "provider_actual";

    /// <summary>按官方公开价格快照估算；APIYI 当前也属于这一档，不代表其实际结算。</summary>
    public const string OfficialBaselineEstimate = "official_baseline_estimate";

    /// <summary>按供应商公开或返回的价格策略估算，仍不是供应商实际账单。</summary>
    public const string ProviderPolicyEstimate = "provider_policy_estimate";

    /// <summary>有用量但缺价格或价格币种不可用。</summary>
    public const string Unpriced = "unpriced";

    /// <summary>上游没有返回可计价用量。</summary>
    public const string NoUsage = "no_usage";

    public static readonly IReadOnlyList<string> All =
    [
        ProviderActual,
        OfficialBaselineEstimate,
        ProviderPolicyEstimate,
        Unpriced,
        NoUsage,
    ];

    /// <summary>
    /// 从已经冻结的请求证据确定金额性质。APIYI 的人工价格只能视作 OpenAI 官方基准，
    /// 不能把尚未建模的供应商分组倍率伪装成实际结算。
    /// </summary>
    public static string Resolve(
        string? costStatus,
        decimal? providerReportedCost,
        string? priceSource,
        string? provider)
    {
        if (providerReportedCost is not null) return ProviderActual;
        if (string.Equals(costStatus, GatewayCostStatus.NoUsage, StringComparison.Ordinal)) return NoUsage;
        if (!string.Equals(costStatus, GatewayCostStatus.Priced, StringComparison.Ordinal)) return Unpriced;

        var normalizedProvider = provider?.Trim() ?? string.Empty;
        if (normalizedProvider.Contains("apiyi", StringComparison.OrdinalIgnoreCase)
            || normalizedProvider.Equals("openai", StringComparison.OrdinalIgnoreCase))
        {
            return OfficialBaselineEstimate;
        }

        return string.Equals(priceSource?.Trim(), "upstream", StringComparison.OrdinalIgnoreCase)
            ? ProviderPolicyEstimate
            : OfficialBaselineEstimate;
    }
}
