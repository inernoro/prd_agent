using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 限流用例的「别骑在分钟边界上」判据本身的用例。
///
/// 它是纯函数，**不需要 Mongo**——这一点是有意的：真正会跨边界失败的那几条用例依赖
/// 真实数据库，本地跑不了，那就至少让「什么时候该等」这个判据在本地可红可绿。
/// </summary>
public sealed class RateWindowTimingTests
{
    private static DateTime At(int second, int millisecond = 0)
        => new(2026, 8, 27, 11, 49, second, millisecond, DateTimeKind.Utc);

    [Fact]
    public void 这一分钟还够用就不等()
    {
        RateWindowTiming.DelayUntilFreshWindow(At(0), TimeSpan.FromSeconds(5))
            .ShouldBe(TimeSpan.Zero);
        RateWindowTiming.DelayUntilFreshWindow(At(54, 999), TimeSpan.FromSeconds(5))
            .ShouldBe(TimeSpan.Zero);
    }

    [Fact]
    public void 剩余不足就等到下一分钟开头()
    {
        // 55.000 秒时只剩 5 秒整；needed 是 5 秒 —— 边界值判「够用」，见上一条。
        // 这里取 55.001，剩余 4.999 秒，不够。
        var delay = RateWindowTiming.DelayUntilFreshWindow(At(55, 1), TimeSpan.FromSeconds(5));
        delay.ShouldBeGreaterThan(TimeSpan.Zero);
        // 等到下一分钟开头（4.999s）再多 50ms 越过边界本身。
        delay.ShouldBe(TimeSpan.FromMilliseconds(4999 + 50));
    }

    [Fact]
    public void 卡在最后一刻要等满一整段()
    {
        var delay = RateWindowTiming.DelayUntilFreshWindow(At(59, 900), TimeSpan.FromSeconds(10));
        delay.ShouldBe(TimeSpan.FromMilliseconds(100 + 50));
    }

    [Fact]
    public void needed_越大越容易触发等待()
    {
        // 同一时刻，短的够用、长的不够 —— 判据真的在看 needed，不是恒真或恒假。
        var now = At(30);
        RateWindowTiming.DelayUntilFreshWindow(now, TimeSpan.FromSeconds(20)).ShouldBe(TimeSpan.Zero);
        RateWindowTiming.DelayUntilFreshWindow(now, TimeSpan.FromSeconds(40)).ShouldBeGreaterThan(TimeSpan.Zero);
    }

    [Fact]
    public void 不在乎边界的调用方直接放行()
    {
        RateWindowTiming.DelayUntilFreshWindow(At(59, 999), TimeSpan.Zero).ShouldBe(TimeSpan.Zero);
        RateWindowTiming.DelayUntilFreshWindow(At(59, 999), TimeSpan.FromSeconds(-1)).ShouldBe(TimeSpan.Zero);
    }

    [Fact]
    public void 等待时长永远不会跨过一整分钟()
    {
        // 判据写错成「等一整分钟」的话这里会红：最坏情况也只该等不到 1 分钟多一点点。
        for (var s = 0; s < 60; s++)
        {
            var delay = RateWindowTiming.DelayUntilFreshWindow(At(s), TimeSpan.FromSeconds(59));
            delay.ShouldBeLessThan(TimeSpan.FromSeconds(60.1));
        }
    }
}
