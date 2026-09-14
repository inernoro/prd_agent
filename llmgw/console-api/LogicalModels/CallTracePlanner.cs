namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>
/// 「调用全貌」面板的推演判据——**镜像**，权威定义在
/// <c>prd-api/src/PrdAgent.Core/LlmGateway/GatewayRouteSelection.cs</c>（运行时 ModelResolver 直接调它）。
///
/// 本项目按既定架构不引用 PrdAgent.*（剥离失败不波及主站，镜像构建上下文也只有
/// llmgw/console-api），所以这里保留一份。镜像不是「再写一遍判据」——两边由
/// <c>prd-api/tests/PrdAgent.Tests/GatewayCallTraceMirrorTests.cs</c> 拿**同一组输入**
/// 喂进去逐条对照结果，任何一侧改了排序、改了跳过条件、改了文案而另一侧没跟上，CI 立刻变红。
/// 对照的是行为不是源码：扫源码只能证明字面量还在，证明不了两边算出同一个答案。
///
/// 为什么值得这么麻烦：面板的价值全部建立在「它说会落到谁，实际就落到谁」上。
/// 一旦两份判据漂了，面板给的就是一份看着很确定的假话——比不给还糟。
/// </summary>
public static class CallTracePlanner
{
    /// <summary>熔断态的数值。与 GatewayRouteSelection.HealthUnavailable 相同。</summary>
    public const int HealthUnavailable = 2;

    /// <summary>与 GatewayRouteSelection.SkipDisabled 逐字相同。</summary>
    public const string SkipDisabled = "这条线路被停用了";

    /// <summary>与 GatewayRouteSelection.SkipQuarantined 逐字相同。</summary>
    public const string SkipQuarantined = "连续失败太多，已被摘掉";

    /// <summary>与 GatewayRouteSelection.SkipTargetDisabled 逐字相同。</summary>
    public const string SkipTargetDisabled = "上游那个模型被停用了";

    /// <param name="Id">线路标识，排序最后一级 tie-break。</param>
    /// <param name="Priority">顺位，小的先。</param>
    /// <param name="Weight">权重，小于 1 的按 1 算。</param>
    /// <param name="HealthStatus">0 健康 / 1 降级 / 2 熔断。</param>
    /// <param name="Enabled">线路自己有没有被停用。</param>
    /// <param name="TargetUsable">它指向的上游模型与所属上游都还启用着吗。</param>
    public readonly record struct RouteCandidate(
        string Id,
        int Priority,
        int Weight,
        int HealthStatus,
        bool Enabled,
        bool TargetUsable = true);

    /// <summary>这条线路为什么不参与；null 表示参与。停用排在熔断前面。</summary>
    public static string? SkipReason(in RouteCandidate candidate)
    {
        if (!candidate.Enabled) return SkipDisabled;
        if (!candidate.TargetUsable) return SkipTargetDisabled;
        if (candidate.HealthStatus == HealthUnavailable) return SkipQuarantined;
        return null;
    }

    /// <summary>参与排队的那些线路。</summary>
    public static List<RouteCandidate> Eligible(IReadOnlyList<RouteCandidate> all)
        => all.Where(x => SkipReason(x) is null).ToList();

    /// <summary>排成这次真实的发送顺序；队首就是会落到的那一条。</summary>
    public static List<RouteCandidate> Queue(IReadOnlyList<RouteCandidate> all, bool weighted, uint seed)
    {
        var ordered = Eligible(all)
            .OrderBy(x => x.HealthStatus == 0 ? 0 : 1)
            .ThenBy(x => x.Priority)
            .ThenBy(x => x.Id, StringComparer.Ordinal)
            .ToList();
        if (!weighted || ordered.Count < 2) return ordered;

        var totalWeight = ordered.Sum(x => Math.Max(1, x.Weight));
        var cursor = (int)(seed % (uint)totalWeight);
        var firstIndex = 0;
        for (var i = 0; i < ordered.Count; i++)
        {
            cursor -= Math.Max(1, ordered[i].Weight);
            if (cursor < 0)
            {
                firstIndex = i;
                break;
            }
        }
        return ordered.Skip(firstIndex).Concat(ordered.Take(firstIndex)).ToList();
    }

    /// <summary>按权重分配时每条被排到队首的概率（百分比，一位小数）。</summary>
    public static IReadOnlyList<(string Id, double Percent)> WeightShare(IReadOnlyList<RouteCandidate> all)
    {
        var eligible = Eligible(all);
        var total = eligible.Sum(x => Math.Max(1, x.Weight));
        if (total <= 0) return [];
        return eligible
            .Select(x => (x.Id, Percent: Math.Round(Math.Max(1, x.Weight) * 100.0 / total, 1)))
            .ToList();
    }

    /// <summary>是不是按权重分配。</summary>
    public static bool IsWeighted(string? routingStrategy)
        => string.Equals(routingStrategy, "weighted", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 面板第一屏那句结论。
    ///
    /// 三种形态，刻意分开：
    ///   - 按顺位：能指名道姓说落到谁。
    ///   - 按权重：**不许**指名道姓，只能给分配比例——说「会落到 A」在按权重时就是编的。
    ///   - 一条都不参与：直说这个模型现在调不通，以及为什么。
    /// </summary>
    public static string Conclusion(
        IReadOnlyList<RouteCandidate> all,
        bool weighted,
        Func<string, string> describeRoute)
    {
        if (all.Count == 0) return "这个模型下面还没有线路，现在调它一定失败。";
        var eligible = Eligible(all);
        if (eligible.Count == 0)
        {
            var quarantined = all.Count(x => SkipReason(x) == SkipQuarantined);
            var disabled = all.Count(x => SkipReason(x) == SkipDisabled);
            var why = quarantined > 0 && disabled > 0
                ? $"{disabled} 条被停用、{quarantined} 条已被摘掉"
                : quarantined > 0 ? $"{quarantined} 条全被摘掉" : $"{disabled} 条全被停用";
            return $"现在调它会失败：{all.Count} 条线路{why}。";
        }
        if (weighted && eligible.Count > 1)
        {
            var share = WeightShare(all)
                .OrderByDescending(x => x.Percent)
                .Select(x => $"{describeRoute(x.Id)} {x.Percent}%");
            return $"现在发一个请求，按权重分到 {eligible.Count} 条线路：{string.Join("、", share)}。";
        }
        var head = Queue(all, weighted, 0)[0];
        var rest = eligible.Count - 1;
        var tail = rest > 0 ? $"，它失败了再往下换，还有 {rest} 条后备" : "，它是唯一一条，失败就没有后备了";
        return $"现在发一个请求，会落到 {describeRoute(head.Id)}{tail}。";
    }
}
