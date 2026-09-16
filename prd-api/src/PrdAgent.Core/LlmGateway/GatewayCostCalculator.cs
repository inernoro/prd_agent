namespace PrdAgent.Core.LlmGateway;

/// <summary>
/// 一次调用的成本明细。分项拆开是为了让这笔账能被复算：
/// 每一项都是「数量 × 当时的单价」，加起来等于 <see cref="Total"/>。
/// </summary>
/// <param name="Input">未命中缓存的输入部分。</param>
/// <param name="Output">输出部分。</param>
/// <param name="CacheRead">命中缓存的输入部分。</param>
/// <param name="CacheWrite">写入缓存的输入部分（Anthropic 一类协议才有）。</param>
/// <param name="Call">每次调用的固定费。</param>
/// <param name="Total">合计，按原币。</param>
/// <param name="Currency">价格币种。</param>
/// <param name="Usd">计入美金汇总与预算闸的金额；只有 <see cref="GatewayCostStatus.Priced"/> 才有值。</param>
/// <param name="Status">这次到底算没算出钱，取值见 <see cref="GatewayCostStatus"/>。</param>
/// <param name="Reason">算不出时的人话原因，直接给控制台显示。</param>
public sealed record GatewayCostBreakdown(
    decimal? Input,
    decimal? Output,
    decimal? CacheRead,
    decimal? CacheWrite,
    decimal? Call,
    decimal? Total,
    string? Currency,
    decimal? Usd,
    string Status,
    string? Reason);

/// <summary>
/// 计价的唯一算法入口。
///
/// 之所以是个独立的纯函数而不是网关里的一段私有方法：这段逻辑要回答的是「这次调用花了多少钱、
/// 算不出的话为什么」，而它此前既没有单测也没有守卫——缓存 token 压根没参与计价、
/// 非美金价格被直接当成美金记账，两个错都能编译通过、能跑、不报错，只在月底对账时显形。
/// 搬出来之后，每条分支都能被一条会变红的用例钉住。
/// </summary>
public static class GatewayCostCalculator
{
    /// <summary>计价口径：这套账只认美金，非 USD 的存量价格一律不进汇总。</summary>
    public const string BillingCurrency = "USD";

    /// <summary>
    /// 缓存命中的 token 是不是已经被算进 <c>InputTokens</c> 里了。
    ///
    /// Anthropic 原生把 <c>cache_read_input_tokens</c> / <c>cache_creation_input_tokens</c> 与
    /// <c>input_tokens</c> 分三个数报；OpenAI 及其兼容层把命中缓存的部分**含在** <c>prompt_tokens</c> 里。
    /// 同一段代码在两种口径下会算出差一截的账，所以按协议分，而不是按经验猜。
    /// </summary>
    public static bool CacheReadCountedInsideInput(string? protocol)
    {
        var normalized = protocol?.Trim().ToLowerInvariant();
        return normalized is not ("anthropic" or "claude");
    }

    /// <summary>按解析结果里的价格快照与上游返回的用量算一次账。</summary>
    public static GatewayCostBreakdown Calculate(
        ModelResolutionResult? resolution,
        GatewayTokenUsage? tokenUsage,
        bool countCall)
        => Calculate(
            protocol: resolution?.Protocol,
            currency: resolution?.PriceCurrency,
            inputPricePerMillion: resolution?.InputPricePerMillion,
            outputPricePerMillion: resolution?.OutputPricePerMillion,
            cachedInputPricePerMillion: resolution?.CachedInputPricePerMillion,
            cacheWritePricePerMillion: resolution?.CacheWritePricePerMillion,
            pricePerCall: resolution?.PricePerCall,
            inputTokens: tokenUsage?.InputTokens ?? 0,
            outputTokens: tokenUsage?.OutputTokens ?? 0,
            cacheReadTokens: tokenUsage?.CacheReadInputTokens ?? 0,
            cacheWriteTokens: tokenUsage?.CacheCreationInputTokens ?? 0,
            countCall: countCall);

    /// <summary>纯参数形态，供单测直接喂值。</summary>
    public static GatewayCostBreakdown Calculate(
        string? protocol,
        string? currency,
        decimal? inputPricePerMillion,
        decimal? outputPricePerMillion,
        decimal? cachedInputPricePerMillion,
        decimal? cacheWritePricePerMillion,
        decimal? pricePerCall,
        int inputTokens,
        int outputTokens,
        int cacheReadTokens,
        int cacheWriteTokens,
        bool countCall)
    {
        var normalizedCurrency = string.IsNullOrWhiteSpace(currency)
            ? null
            : currency.Trim().ToUpperInvariant();

        var rawInput = Math.Max(0, inputTokens);
        var output = Math.Max(0, outputTokens);
        var cacheRead = Math.Max(0, cacheReadTokens);
        var cacheWrite = Math.Max(0, cacheWriteTokens);

        // 扣减只在「缓存确实含在输入里」且「扣得动」时发生。扣不动说明这个上游其实是分开报的，
        // 此时硬扣会把可计费输入压成 0、成本凭空少一截——宁可不扣，也不要算出一笔假账。
        var billableInput = rawInput;
        if (CacheReadCountedInsideInput(protocol) && cacheRead > 0 && cacheRead <= rawInput)
        {
            billableInput = rawInput - cacheRead;
        }

        // 没配缓存价不等于缓存免费，只等于「不知道」——按输入全价算。高估会促使人把价格补上，
        // 低估则会悄悄放大真实开销，而限额正是靠这个数守着的。
        var cacheReadPrice = cachedInputPricePerMillion ?? inputPricePerMillion;
        var cacheWritePrice = cacheWritePricePerMillion ?? inputPricePerMillion;

        var callCost = countCall && pricePerCall is decimal fixedFee
            ? Round(Math.Max(0, fixedFee))
            : (decimal?)null;

        // 按次计费就只按次算，token 费用一分都不叠加。
        //
        // 两种价都填得进去（价格抽屉没拦），而「都填了」并不意味着「两种都收」——
        // 它多半是填错了。叠加的后果是每一次成功调用都按两套价重复收费，Total 与 Usd
        // 一起虚高，用量合计与预算闸跟着一起错，而配置看上去完全正常。
        //
        // 真要支持「按次 + 按 token」同时计费，那是一种新的计费模式，得显式存一个
        // billing mode 让人明确表态，而不是靠「两个字段都非空」去猜
        // （形状 6：判据读的值不是真正生效的那个——这里是「填了什么」被当成了「怎么收费」）。
        var billedPerCall = callCost is not null;
        var inputCost = billedPerCall ? null : PerMillion(billableInput, inputPricePerMillion);
        var outputCost = billedPerCall ? null : PerMillion(output, outputPricePerMillion);
        var cacheReadCost = billedPerCall ? null : PerMillion(cacheRead, cacheReadPrice);
        var cacheWriteCost = billedPerCall ? null : PerMillion(cacheWrite, cacheWritePrice);

        var (status, reason) = Classify(
            normalizedCurrency,
            hasUsage: rawInput > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0,
            billableInput: billableInput,
            outputTokens: output,
            cacheRead: cacheRead,
            cacheWrite: cacheWrite,
            inputPrice: inputPricePerMillion,
            outputPrice: outputPricePerMillion,
            cacheReadPrice: cacheReadPrice,
            cacheWritePrice: cacheWritePrice,
            callCost: callCost);

        var parts = new[] { inputCost, outputCost, cacheReadCost, cacheWriteCost, callCost }
            .Where(x => x is not null)
            .Select(x => x!.Value)
            .ToList();

        if (parts.Count == 0)
        {
            return new GatewayCostBreakdown(
                null, null, null, null, null, null, normalizedCurrency, null, status, reason);
        }

        var total = Round(parts.Sum());
        // 只有确实按美金口径算全了的账才允许进美金汇总——预算闸读的就是这个数。
        var usd = GatewayCostStatus.CountsTowardBudget(status) ? total : (decimal?)null;
        return new GatewayCostBreakdown(
            inputCost, outputCost, cacheReadCost, cacheWriteCost, callCost, total, normalizedCurrency, usd, status, reason);
    }

    /// <summary>
    /// 判定这次调用到底算没算出钱，以及算不出时的人话原因。
    ///
    /// 这个判定是「避免滥用」的地基：算不出钱的调用如果被当成零成本静默放过，限额就形同虚设。
    /// 所以结论收敛成有限的四种状态，每种都带一句能直接给人看的下一步。
    /// </summary>
    private static (string Status, string? Reason) Classify(
        string? currency,
        bool hasUsage,
        int billableInput,
        int outputTokens,
        int cacheRead,
        int cacheWrite,
        decimal? inputPrice,
        decimal? outputPrice,
        decimal? cacheReadPrice,
        decimal? cacheWritePrice,
        decimal? callCost)
    {
        if (!hasUsage && callCost is null)
        {
            return (GatewayCostStatus.NoUsage, "上游没有返回 token 用量，这次调用无法计价。");
        }

        if (currency is null)
        {
            return (GatewayCostStatus.StaleCurrency,
                "这条模型的价格没有声明币种，计价只认美金。去模型管理确认并改成 USD 后才会计入用量与限额。");
        }

        if (!string.Equals(currency, BillingCurrency, StringComparison.OrdinalIgnoreCase))
        {
            return (GatewayCostStatus.StaleCurrency,
                $"这条模型的价格还是 {currency} 口径，计价只认美金。去模型管理把它换算成 USD 后才会计入用量与限额。");
        }

        // 按次计价的模型不要求 token 单价。
        //
        // 生图、视频这类模型按张/次收费，token 用量是上游顺带回的**信息**，不是计费依据。
        // 不排除它的话，一个价格配齐的按次计费模型会仅仅因为供应商回了非零 usage 就被判成
        // unpriced：按次的钱照样算进 Total，但 Usd 变成 null，于是这笔调用被整个排除在
        // 用量合计与预算之外——配置完全正确，账却对不上（形状 1：判据比它该管的范围窄，
        // 「按次计费」这种输入让它给出了相反答案）。
        //
        // 只配了按次价就按按次算。两种价都填了时同样只按次算——合计那一段也是这么做的，
        // 两处必须同一个口径，否则会出现「判成按次计价、却按两套价收钱」。
        var billedPerCall = callCost is not null;
        var missing = new List<string>();
        if (!billedPerCall)
        {
            if (billableInput > 0 && inputPrice is null) missing.Add("输入单价");
            if (outputTokens > 0 && outputPrice is null) missing.Add("输出单价");
            if (cacheRead > 0 && cacheReadPrice is null) missing.Add("缓存读单价");
            if (cacheWrite > 0 && cacheWritePrice is null) missing.Add("缓存写单价");
        }

        if (missing.Count > 0)
        {
            return (GatewayCostStatus.Unpriced,
                $"这条模型缺少{string.Join("、", missing)}，这次调用没有计入成本。去模型管理补上价格。");
        }

        return (GatewayCostStatus.Priced, null);
    }

    private static decimal? PerMillion(int tokens, decimal? pricePerMillion)
        => tokens > 0 && pricePerMillion is decimal price
            ? Round(tokens * price / 1_000_000m)
            : null;

    private static decimal Round(decimal value)
        => Math.Round(value, 8, MidpointRounding.AwayFromZero);
}
