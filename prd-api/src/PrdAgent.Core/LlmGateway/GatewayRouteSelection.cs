namespace PrdAgent.Core.LlmGateway;

/// <summary>
/// 「一个对外模型下的线路，这次该排成什么顺序、哪些根本不参与」的**唯一判据**。
///
/// 为什么要抽出来：控制台的「调用全貌」面板要回答同一个问题（现在发一个请求会落到谁），
/// 而它跑在独立的 console-api 里、按既定架构不引用 PrdAgent.*。两边各写一遍，
/// 就是 predicate-and-wiring-discipline 形状 3（判据分裂各自漂移）——面板说落到 A、
/// 实际落到 B，而且没有任何东西会发现。
///
/// 所以这里只放**纯函数**：不碰数据库、不碰时钟、不碰请求上下文。
/// 运行时 <c>ModelResolver</c> 调它，console-api 那份镜像（<c>CallTracePlanner</c>）逐字对齐，
/// 测试项目同时引用两边，拿同一组输入喂进去断言结果一致——不是扫源码，是行为对照。
///
/// 判据本身只有两条，刻意保持这么小：
///   1. 哪些线路不参与（停用 / 熔断）——<see cref="SkipReason"/>
///   2. 参与的怎么排队——<see cref="Queue"/>
/// 半开试探（把一条熔断线路临时插到队首）不在这里：它要抢租约、要写库，
/// 不是纯函数；面板也只把它标成「可能被试探」，不当成确定的下一跳。
/// </summary>
public static class GatewayRouteSelection
{
    /// <summary>熔断态的数值，与 <c>ModelHealthStatus.Unavailable</c> 相同。</summary>
    public const int HealthUnavailable = 2;

    /// <summary>线路被停用时的跳过原因。文案是产品语义，镜像两侧必须逐字相同。</summary>
    public const string SkipDisabled = "这条线路被停用了";

    /// <summary>线路熔断时的跳过原因。</summary>
    public const string SkipQuarantined = "连续失败太多，已被摘掉";

    /// <param name="Id">线路标识。排序里做最后一级 tie-break，所以必须稳定。</param>
    /// <param name="Priority">顺位，小的先。</param>
    /// <param name="Weight">权重，只在按权重分配时有意义；小于 1 的按 1 算。</param>
    /// <param name="HealthStatus">0 健康 / 1 降级 / 2 熔断。</param>
    /// <param name="Enabled">这条线路自己有没有被停用。</param>
    public readonly record struct RouteCandidate(
        string Id,
        int Priority,
        int Weight,
        int HealthStatus,
        bool Enabled);

    /// <summary>
    /// 这条线路为什么不参与这次排队；<c>null</c> 表示参与。
    ///
    /// 停用排在熔断前面：一条既停用又熔断的线路，人要先知道它是被人关掉的，
    /// 「连续失败太多」会把人引去查上游，而那不是原因。
    /// </summary>
    public static string? SkipReason(in RouteCandidate candidate)
    {
        if (!candidate.Enabled) return SkipDisabled;
        if (candidate.HealthStatus == HealthUnavailable) return SkipQuarantined;
        return null;
    }

    /// <summary>参与排队的那些线路。</summary>
    public static List<RouteCandidate> Eligible(IReadOnlyList<RouteCandidate> all)
        => all.Where(x => SkipReason(x) is null).ToList();

    /// <summary>
    /// 把参与排队的线路排成这次真实的发送顺序。队首就是这次会落到的那一条。
    ///
    /// 三级排序：健康的排在降级的前面 → 顺位小的在前 → 线路标识（保证同分时次序稳定，
    /// 否则同一份数据两次调用能给出不同答案，面板和实际就会无故对不上）。
    ///
    /// 按权重分配时，在排好的队列上按 <paramref name="seed"/> 落点旋转一次：
    /// 权重大的被旋到队首的概率大，而后备顺序仍然保留（失败了照样往下走）。
    /// seed 由调用方给（运行时用 requestId 派生，面板用固定值），
    /// 这样这个函数本身没有随机性，可测。
    /// </summary>
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

    /// <summary>
    /// 按权重分配时，每条线路被排到队首的概率（百分比，四舍五入到一位小数）。
    ///
    /// 面板不能在按权重分配时谎称「会落到 A」——那是编的。它给的是分配比例。
    /// </summary>
    public static IReadOnlyList<(string Id, double Percent)> WeightShare(IReadOnlyList<RouteCandidate> all)
    {
        var eligible = Eligible(all);
        var total = eligible.Sum(x => Math.Max(1, x.Weight));
        if (total <= 0) return [];
        return eligible
            .Select(x => (x.Id, Percent: Math.Round(Math.Max(1, x.Weight) * 100.0 / total, 1)))
            .ToList();
    }

    /// <summary>是不是按权重分配。策略串只有这一个值触发，其余一律按顺位。</summary>
    public static bool IsWeighted(string? routingStrategy)
        => string.Equals(routingStrategy, "weighted", StringComparison.OrdinalIgnoreCase);
}
