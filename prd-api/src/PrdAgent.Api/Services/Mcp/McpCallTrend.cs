namespace PrdAgent.Api.Services.Mcp;

/// <summary>按 UTC 整点对齐的最近 24 个小时；最后一桶截止到查询时刻。</summary>
public static class McpCallTrend
{
    public sealed record Point(DateTime HourUtc, long Calls);
    public sealed record Window(DateTime SinceUtc, DateTime UntilUtc, IReadOnlyList<Point> Points);

    public static DateTime Start(DateTime nowUtc)
        => new DateTime(nowUtc.Year, nowUtc.Month, nowUtc.Day, nowUtc.Hour, 0, 0, DateTimeKind.Utc).AddHours(-23);

    public static Window Build(DateTime nowUtc, IReadOnlyDictionary<DateTime, long> counts)
    {
        var start = Start(nowUtc);
        return new Window(start, nowUtc, Enumerable.Range(0, 24).Select(offset =>
        {
            var hour = start.AddHours(offset);
            return new Point(hour, counts.TryGetValue(hour, out var count) ? count : 0);
        }).ToList());
    }
}
