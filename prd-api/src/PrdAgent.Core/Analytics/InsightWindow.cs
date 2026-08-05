namespace PrdAgent.Core.Analytics;

/// <summary>
/// 洞察聚合的时间窗。<see cref="Start"/> 闭、<see cref="End"/> 开，两端都对齐到 UTC 日边界。
/// 无界窗口（全部时间）用 <see cref="Bounded"/>=false 表达，此时 Start 为 <see cref="DateTime.MinValue"/>。
/// </summary>
public sealed record InsightWindow(
    DateTime Start,
    DateTime End,
    DateTime? PrevStart,
    DateTime? PrevEnd,
    int SpanDays,
    bool Bounded)
{
    /// <summary>有等长的上一窗可比，才允许出环比。</summary>
    public bool HasPrev => PrevStart != null && PrevEnd != null;

    /// <summary>日序列只在窗口有界且不太长时给；超长窗口返回空数组而不是编造。</summary>
    public bool WantSeries => Bounded && SpanDays > 0 && SpanDays <= InsightWindowResolver.MaxSeriesDays;

    /// <summary>日均一类指标的分母。无界窗口没有可信分母，交给调用方用实际序列长度兜底。</summary>
    public int? DailyDivisor => Bounded && SpanDays > 0 ? SpanDays : null;
}

/// <summary>
/// 把 from/to/days 三种入参归一成同一个 <see cref="InsightWindow"/>。
///
/// 之所以抽成纯函数：窗口解析要同时满足「面板用滚动天数」和「周报用精确 ISO 周区间」两种调用方，
/// 而这段逻辑一旦写在 Controller 里就只能靠跑数据库才能验证，改错了没人拦得住。
/// </summary>
public static class InsightWindowResolver
{
    /// <summary>超过这个天数就不给日序列（点太密，图上读不出东西）。</summary>
    public const int MaxSeriesDays = 45;

    /// <summary>
    /// 解析时间窗。<paramref name="to"/> 按「闭区间的最后一天」理解（与周报按日期文本
    /// <c>d &gt;= MONDAY &amp;&amp; d &lt;= SUNDAY</c> 的口径一致），内部转成开区间右边界。
    /// </summary>
    /// <returns>解析成功返回窗口；入参自相矛盾（from 晚于 to）返回 null，由调用方回 400。</returns>
    public static InsightWindow? Resolve(DateTime? from, DateTime? to, int days, DateTime nowUtc)
    {
        var todayExclusive = nowUtc.Date.AddDays(1);

        if (from == null && to == null)
        {
            // 兼容路径：滚动天数。days<=0 视为全部时间。
            if (days <= 0) return Unbounded(todayExclusive);
            var rollingStart = todayExclusive.AddDays(-days);
            return Bounded(rollingStart, todayExclusive);
        }

        // 右边界：给了就用（转开区间），没给就到今天为止；无论如何不许伸到未来——
        // 未来的窗口只会让分母变大、日均变小，是一种看不出来的注水。
        var end = to != null ? to.Value.Date.AddDays(1) : todayExclusive;
        if (end > todayExclusive) end = todayExclusive;

        if (from == null)
        {
            // 只给右边界：左边界仍然无界。此时没有可信的 span，不给环比也不给日序列。
            return new InsightWindow(DateTime.MinValue, end, null, null, 0, false);
        }

        var start = from.Value.Date;
        if (start >= end) return null;
        return Bounded(start, end);
    }

    private static InsightWindow Unbounded(DateTime end) =>
        new(DateTime.MinValue, end, null, null, 0, false);

    private static InsightWindow Bounded(DateTime start, DateTime end)
    {
        var span = (end - start).Days;
        // 等长紧邻前移：上一窗必须和本窗同长度，否则环比比的是两个尺子。
        return new InsightWindow(start, end, start.AddDays(-span), start, span, true);
    }
}
