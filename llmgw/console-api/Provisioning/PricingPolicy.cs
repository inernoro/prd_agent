namespace PrdAgent.LlmGw.Provisioning;

/// <summary>
/// 价格的口径与时效策略，控制台这一侧的唯一判定源。
///
/// **为什么要有它**：此前价格只是模型文档上四个裸数字，既说不出从哪来，也说不出是什么时候的。
/// 于是两种坏情况同时存在——上游根本不返回价格的模型（OpenAI 官方清单就没有 pricing 字段）
/// 一直是空的，成本报表按零算；而人工填过一次的价格放上半年也没人知道该不该信。
/// 「看起来是真的、其实早已过时」的价格比没有价格更危险，因为报表照算，没人会去核对。
///
/// 所以价格不再是数字，而是「数字 + 从哪来 + 什么时候的」三件套，缺一不可。
/// </summary>
public static class PricingPolicy
{
    /// <summary>计价口径：只认美金。非 USD 的价格不进用量汇总，也不参与限额。</summary>
    public const string BillingCurrency = "USD";

    /// <summary>超过这么多天没复核，价格判为陈旧，控制台上标出来催人核一遍。</summary>
    public const int ReviewIntervalDays = 30;

    /// <summary>价格来自上游模型清单返回的 pricing 字段。</summary>
    public const string SourceUpstream = "upstream";

    /// <summary>价格由人在控制台填的。</summary>
    public const string SourceAdmin = "admin";

    /// <summary>价格由历史非美金价换算而来。</summary>
    public const string SourceMigrated = "migrated";

    /// <summary>全部合法来源。不在表里的一律当作「没有来源可考」。</summary>
    public static readonly IReadOnlyList<string> AllSources = new[] { SourceUpstream, SourceAdmin, SourceMigrated };

    /// <summary>把任意输入收敛成合法来源；认不出来就是 null，绝不瞎猜一个。</summary>
    public static string? NormalizeSource(string? source)
    {
        var normalized = source?.Trim().ToLowerInvariant();
        return normalized is not null && AllSources.Contains(normalized) ? normalized : null;
    }

    /// <summary>币种一律归一到大写；只接受 USD 与历史遗留的 CNY，其余按未声明处理。</summary>
    public static string? NormalizeCurrency(string? currency)
    {
        var normalized = currency?.Trim().ToUpperInvariant();
        return normalized is "USD" or "CNY" ? normalized : null;
    }

    /// <summary>这份价格是不是已经到了该复核的时候。没有观测时间的一律算陈旧——说不出时间就是没根。</summary>
    public static bool IsStale(DateTime? observedAt, DateTime now)
        => observedAt is null || (now - observedAt.Value).TotalDays > ReviewIntervalDays;

    /// <summary>距离上次观测过了多少天；没有观测时间返回 null。</summary>
    public static int? AgeInDays(DateTime? observedAt, DateTime now)
        => observedAt is null ? null : Math.Max(0, (int)Math.Floor((now - observedAt.Value).TotalDays));

    /// <summary>这条模型有没有配任何价格。</summary>
    public static bool HasAnyPrice(
        decimal? inputPricePerMillion,
        decimal? outputPricePerMillion,
        decimal? pricePerCall)
        => inputPricePerMillion is not null || outputPricePerMillion is not null || pricePerCall is not null;

    /// <summary>
    /// 这条模型的价格**配齐了**没有——按计价那一侧真正要求的口径，不是「配了一项就算」。
    ///
    /// 计价（GatewayCostCalculator.Classify）的规矩是：有按次价就只按次算，token 单价一概不问；
    /// 否则每一种出现了用量的 token 都必须有单价，缺任何一种整笔调用判 unpriced，
    /// EstimatedCostUsd 为 null、整笔掉出预算。一次正常的对话响应必然同时有输入与输出，
    /// 所以模型这一侧的等价口径就是「有按次价，或者输入与输出两个单价都有」。
    ///
    /// 缓存那两档不要求：没配时计价按输入全价回落，算得出钱。
    /// </summary>
    public static bool HasCompletePrice(
        decimal? inputPricePerMillion,
        decimal? outputPricePerMillion,
        decimal? pricePerCall)
        => pricePerCall is not null
           || (inputPricePerMillion is not null && outputPricePerMillion is not null);

    /// <summary>
    /// 这条模型的价格能不能用来记账：得配齐、币种得是美金。
    /// 两条里缺任何一条，它的调用在用量里都会显示为「没计上钱」而不是零成本。
    ///
    /// 这里判的是**配齐**而不是「配了任意一项」。只配了输入单价的对话模型，
    /// 按「配了一项就算」会被标成可计费、模型页于是不显示那句「不计入限额」的提醒，
    /// 而它的每一次正常调用都因为缺输出单价被判 unpriced——界面说算得出钱，账上一分没有
    /// （形状 3：同一个判据在模型页与计价侧各写各的，两个都自称权威）。
    /// </summary>
    public static bool IsBillable(
        decimal? inputPricePerMillion,
        decimal? outputPricePerMillion,
        decimal? pricePerCall,
        string? currency)
        => HasCompletePrice(inputPricePerMillion, outputPricePerMillion, pricePerCall)
           && string.Equals(NormalizeCurrency(currency), BillingCurrency, StringComparison.Ordinal);

    /// <summary>价格必须非负；负价是输入错误，不是「不计费」。</summary>
    public static bool IsValidPrice(decimal? price) => price is null or >= 0;
}
