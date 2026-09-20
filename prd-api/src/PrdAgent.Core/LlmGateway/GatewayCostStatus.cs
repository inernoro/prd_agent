namespace PrdAgent.Core.LlmGateway;

/// <summary>
/// 一次调用「算没算出钱」的结论。取值有限，禁止再往日志里写自由文本的成本状态。
///
/// 存在的理由是限额：算不出钱的调用如果被当成零成本静默放过，限额就形同虚设，
/// 而「很多模型压根没配价」正是这套计价此前最大的窟窿。把结论收敛成四种可数的状态之后，
/// 「这个月有多少调用没计上钱、卡在哪个模型」才成为一个能查、能报警、能拦的事实。
/// </summary>
public static class GatewayCostStatus
{
    /// <summary>按美金口径算全了，金额可进用量汇总与预算闸。</summary>
    public const string Priced = "priced";

    /// <summary>有 token 用量，但对应的单价没配，这次调用不计成本。</summary>
    public const string Unpriced = "unpriced";

    /// <summary>价格不是美金口径（存量 CNY 或没声明币种），不敢按美金记账。</summary>
    public const string StaleCurrency = "stale_currency";

    /// <summary>上游没有返回 token 用量，无从计价。</summary>
    public const string NoUsage = "no_usage";

    /// <summary>全部合法取值，供守卫与消费方遍历。</summary>
    public static readonly IReadOnlyList<string> All = new[] { Priced, Unpriced, StaleCurrency, NoUsage };

    /// <summary>只有 <see cref="Priced"/> 的金额允许计入美金汇总与限额。</summary>
    public static bool CountsTowardBudget(string? status)
        => string.Equals(status, Priced, StringComparison.Ordinal);
}
