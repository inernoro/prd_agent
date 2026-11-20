using PrdAgent.Core.Services.ReportAgent;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 新建周报默认归属周：最近一个尚未截止的周（上周截止 = 本周一 24:00 UTC+8）。
/// 用例时间均以 UTC+8 书写，再换算成 UTC 传入。
/// </summary>
public sealed class WeeklyReportDefaultSubmissionWeekTests
{
    private static DateTime China(int y, int m, int d, int h, int min, int s = 0)
        => new DateTime(y, m, d, h, min, s, DateTimeKind.Utc).AddHours(-8);

    [Theory]
    // 2026-11-23 是 W48 周一：当天任何时刻都默认上一周 W47
    [InlineData(2026, 11, 23, 0, 30, 0, 2026, 47)]
    [InlineData(2026, 11, 23, 10, 0, 0, 2026, 47)]
    [InlineData(2026, 11, 23, 23, 59, 59, 2026, 47)]
    // 周二 00:00 之后上周已截止，默认本周 W48
    [InlineData(2026, 11, 24, 0, 0, 1, 2026, 48)]
    [InlineData(2026, 11, 27, 16, 0, 0, 2026, 48)]
    [InlineData(2026, 11, 29, 22, 0, 0, 2026, 48)]
    // 跨年：2026 年有 53 周，2027-01-04（周一）应回到 2026-W53，而不是 W52
    [InlineData(2027, 1, 4, 10, 0, 0, 2026, 53)]
    [InlineData(2027, 1, 5, 9, 0, 0, 2027, 1)]
    public void ResolvesNearestOpenWeek(int y, int m, int d, int h, int min, int s, int expectedYear, int expectedWeek)
    {
        var (weekYear, weekNumber) = WeeklyReportSubmissionRules.ResolveDefaultSubmissionWeek(China(y, m, d, h, min, s));
        Assert.Equal((expectedYear, expectedWeek), (weekYear, weekNumber));
    }

    [Fact]
    public void DeadlineInstant_StillBelongsToPreviousWeek()
    {
        // 截止判定是「严格晚于才算超时」，恰好在截止时刻仍归上一周
        var deadline = WeeklyReportSubmissionRules.ResolveWeekDeadline(2026, 47, null);
        Assert.Equal((2026, 47), WeeklyReportSubmissionRules.ResolveDefaultSubmissionWeek(deadline));
        Assert.Equal((2026, 48), WeeklyReportSubmissionRules.ResolveDefaultSubmissionWeek(deadline.AddSeconds(1)));
    }
}
