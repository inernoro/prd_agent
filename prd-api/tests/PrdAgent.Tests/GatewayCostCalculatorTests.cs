using PrdAgent.Core.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 计价算法的判据。此前这段逻辑没有任何用例：缓存 token 不参与计价、非美金价格被当美金记账，
/// 两个错都能编译、能跑、不报错，只在对账时显形。下面每条用例都对应一种曾经算错或会算错的形态，
/// 把算法改回旧行为其中至少一条必红。
/// </summary>
public sealed class GatewayCostCalculatorTests
{
    private static GatewayCostBreakdown Calc(
        string? protocol = "openai",
        string? currency = "USD",
        decimal? inputPrice = 2.50m,
        decimal? outputPrice = 10.00m,
        decimal? cachedInputPrice = 0.625m,
        decimal? cacheWritePrice = null,
        decimal? pricePerCall = null,
        int inputTokens = 0,
        int outputTokens = 0,
        int cacheReadTokens = 0,
        int cacheWriteTokens = 0,
        bool countCall = true)
        => GatewayCostCalculator.Calculate(
            protocol, currency, inputPrice, outputPrice, cachedInputPrice, cacheWritePrice, pricePerCall,
            inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, countCall);

    /// <summary>
    /// OpenAI 口径：命中缓存的 token 已经含在 prompt_tokens 里，必须先扣掉再按缓存价单算。
    /// 不扣的话这笔账会从 0.03 变成 0.045——多算一半，且多得很稳定，没人会发现。
    /// </summary>
    [Fact]
    public void OpenAi协议_缓存命中先从输入扣减再按缓存价单算()
    {
        var cost = Calc(protocol: "openai", inputTokens: 12_000, outputTokens: 1_500, cacheReadTokens: 8_000);

        Assert.Equal(GatewayCostStatus.Priced, cost.Status);
        Assert.Equal(0.01m, cost.Input);        // (12000 - 8000) * 2.50 / 1M
        Assert.Equal(0.005m, cost.CacheRead);   // 8000 * 0.625 / 1M
        Assert.Equal(0.015m, cost.Output);      // 1500 * 10.00 / 1M
        Assert.Equal(0.03m, cost.Total);
        Assert.Equal(0.03m, cost.Usd);
    }

    /// <summary>
    /// Anthropic 口径：三个数各报各的，输入不许再扣一次。扣了的话输入部分会凭空少一截。
    /// </summary>
    [Fact]
    public void Anthropic协议_缓存独立计数不从输入扣减()
    {
        var cost = Calc(
            protocol: "anthropic",
            inputPrice: 3.00m, outputPrice: 15.00m, cachedInputPrice: 0.30m, cacheWritePrice: 3.75m,
            inputTokens: 4_000, outputTokens: 1_000, cacheReadTokens: 8_000, cacheWriteTokens: 2_000);

        Assert.Equal(GatewayCostStatus.Priced, cost.Status);
        Assert.Equal(0.012m, cost.Input);        // 4000 * 3.00 / 1M，没有被缓存读扣减
        Assert.Equal(0.0024m, cost.CacheRead);   // 8000 * 0.30 / 1M
        Assert.Equal(0.0075m, cost.CacheWrite);  // 2000 * 3.75 / 1M
        Assert.Equal(0.015m, cost.Output);
        Assert.Equal(0.0369m, cost.Total);
    }

    /// <summary>
    /// 缓存读比输入还多，说明这个上游其实是分开报的，哪怕协议名看着像 OpenAI 也不能扣——
    /// 硬扣会把可计费输入压成 0，账直接少一大块。
    /// </summary>
    [Fact]
    public void 缓存读超过输入时不扣减_避免把输入压成零()
    {
        var cost = Calc(protocol: "openai", inputTokens: 1_000, cacheReadTokens: 5_000);

        Assert.Equal(0.0025m, cost.Input);      // 1000 * 2.50 / 1M，原样计费
        Assert.Equal(0.003125m, cost.CacheRead); // 5000 * 0.625 / 1M
    }

    /// <summary>没配缓存价不等于缓存免费，按输入全价算：宁可高估促人补价，也不低估放大真实开销。</summary>
    [Fact]
    public void 没配缓存价时按输入全价算_不当成免费()
    {
        var cost = Calc(protocol: "openai", cachedInputPrice: null, inputTokens: 10_000, cacheReadTokens: 6_000);

        Assert.Equal(0.01m, cost.Input);      // (10000 - 6000) * 2.50 / 1M
        Assert.Equal(0.015m, cost.CacheRead); // 6000 * 2.50 / 1M，按全价
        Assert.Equal(GatewayCostStatus.Priced, cost.Status);
    }

    /// <summary>非美金的存量价格不进美金汇总：按 CNY 数字当美金记，成本会被低估一个数量级。</summary>
    [Fact]
    public void 非美金价格判为口径待迁移且不进美金汇总()
    {
        var cost = Calc(currency: "CNY", inputTokens: 10_000, outputTokens: 1_000);

        Assert.Equal(GatewayCostStatus.StaleCurrency, cost.Status);
        Assert.Null(cost.Usd);
        Assert.NotNull(cost.Total);   // 原币金额仍算出来，供排查
        Assert.Contains("CNY", cost.Reason);
    }

    /// <summary>历史数据没有声明币种，同样不敢当美金记账。</summary>
    [Fact]
    public void 缺币种同样判为口径待迁移()
    {
        var cost = Calc(currency: null, inputTokens: 10_000);

        Assert.Equal(GatewayCostStatus.StaleCurrency, cost.Status);
        Assert.Null(cost.Usd);
    }

    /// <summary>有用量但缺单价：这次调用必须被记成 unpriced 并说清缺哪一项，而不是静默当零成本。</summary>
    [Fact]
    public void 缺单价时判为未计价并点名缺哪一项()
    {
        var cost = Calc(inputPrice: null, cachedInputPrice: null, inputTokens: 10_000, outputTokens: 500);

        Assert.Equal(GatewayCostStatus.Unpriced, cost.Status);
        Assert.Null(cost.Usd);
        Assert.Contains("输入单价", cost.Reason);
    }

    /// <summary>上游没给用量就无从计价，这与「缺价」是两回事，不能混成同一个状态。</summary>
    [Fact]
    public void 上游没返回用量时判为无用量()
    {
        var cost = Calc(inputTokens: 0, outputTokens: 0);

        Assert.Equal(GatewayCostStatus.NoUsage, cost.Status);
        Assert.Null(cost.Total);
    }

    /// <summary>按次计费的模型即使没有 token 用量也要算出钱来。</summary>
    [Fact]
    public void 按次计费在没有token用量时依然计价()
    {
        var cost = Calc(inputPrice: null, outputPrice: null, cachedInputPrice: null, pricePerCall: 0.04m);

        Assert.Equal(GatewayCostStatus.Priced, cost.Status);
        Assert.Equal(0.04m, cost.Call);
        Assert.Equal(0.04m, cost.Usd);
    }

    /// <summary>只有 priced 的金额允许进预算闸，其余三种状态一律不计入。</summary>
    [Fact]
    public void 只有已计价状态才计入预算()
    {
        Assert.True(GatewayCostStatus.CountsTowardBudget(GatewayCostStatus.Priced));
        Assert.False(GatewayCostStatus.CountsTowardBudget(GatewayCostStatus.Unpriced));
        Assert.False(GatewayCostStatus.CountsTowardBudget(GatewayCostStatus.StaleCurrency));
        Assert.False(GatewayCostStatus.CountsTowardBudget(GatewayCostStatus.NoUsage));
        Assert.False(GatewayCostStatus.CountsTowardBudget(null));
    }
}
