namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 「这一分钟还剩得够不够跑完一组限流用例」的判据。
///
/// ## 为什么需要它
///
/// 网关的按分钟限流把窗口键取到**墙钟分钟**（`GatewayRuntimeGovernance` 里
/// `windowStart = new DateTime(..., now.Minute, 0)`）。几条限流用例连发多次请求，
/// 然后断言「窗口集合里**只有一条**记录、计数等于发出的次数」。
///
/// 这串请求一旦跨过分钟边界，就会插出第二条窗口、计数从头算：`SingleAsync()` 抛
/// 「不止一条」，超限那次也不再被拒。概率不高，但它是真的会中——2026-08-27 的 CI
/// 上就红过一次，而那次前后一行相关代码都没改。
///
/// ## 为什么不改生产代码
///
/// 把时钟注进 `GatewayRuntimeGovernance` 也能解决，但那是为了让测试好写去改真实
/// 限流路径的形状。这里要排除的只是「用例自己骑在边界上」这一件事，所以判据留在
/// 测试侧：开跑前先看这一分钟还剩多少，不够就等到下一分钟开头再开始。
///
/// **这不削弱断言**：断言的仍然是「同一个窗口内超限必须被拒、窗口只有一条」，
/// 只是不再把「恰好跨分钟」也算进被测范围——那本来就不是这几条用例要证明的东西。
/// </summary>
internal static class RateWindowTiming
{
    /// <summary>
    /// 距离下一分钟开头还有多久要等。
    /// </summary>
    /// <param name="nowUtc">当前时刻（UTC）。</param>
    /// <param name="needed">这组用例预计要占用的时间；剩余不足这么多就等。</param>
    /// <returns>需要等待的时长；`TimeSpan.Zero` 表示这一分钟够用、直接开跑。</returns>
    public static TimeSpan DelayUntilFreshWindow(DateTime nowUtc, TimeSpan needed)
    {
        // 负数或零的 needed 表示调用方不在乎边界，直接放行——省得它自己再判一次。
        if (needed <= TimeSpan.Zero) return TimeSpan.Zero;

        var elapsedInMinute = TimeSpan.FromSeconds(nowUtc.Second)
            + TimeSpan.FromMilliseconds(nowUtc.Millisecond);
        var remaining = TimeSpan.FromMinutes(1) - elapsedInMinute;
        if (remaining >= needed) return TimeSpan.Zero;

        // 多睡 50ms 越过边界本身：正好落在 :00.000 上时，窗口取键仍可能算到上一分钟
        // （不同机器的时钟精度不一样），多这一点点把边界本身也排除掉。
        return remaining + TimeSpan.FromMilliseconds(50);
    }
}
