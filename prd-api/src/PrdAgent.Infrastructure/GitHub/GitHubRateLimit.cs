using System.Net.Http;

namespace PrdAgent.Infrastructure.GitHub;

/// <summary>
/// GitHub 限额判据的唯一定义（PR 审查、连接中心、目录同步共用）。
///
/// GitHub 把「主限额耗尽」报成 403 而不是 429，只能靠 <c>X-RateLimit-Remaining: 0</c> 区分。
/// 判据分两份就会漂：一侧提示「请在 HH:mm:ss 后重试」，另一侧只说「拒绝访问该资源」，
/// 用户拿着后一句去查权限，查不出任何东西。
/// </summary>
public static class GitHubRateLimit
{
    /// <summary>这次 403/429 是不是限额耗尽（看 X-RateLimit-Remaining 是否为 0）。</summary>
    public static bool IsExhausted(HttpResponseMessage resp)
    {
        if (!resp.Headers.TryGetValues("X-RateLimit-Remaining", out var remaining)) return false;
        var first = remaining.FirstOrDefault();
        return first != null && int.TryParse(first, out var r) && r == 0;
    }

    /// <summary>
    /// 还要等多久（「约 12 分钟」）；拿不到就返回 null，由调用方退回泛化文案。
    ///
    /// 给的是**时长**不是时刻：服务端镜像不配时区，格式化出来的 HH:mm:ss 是容器的 UTC 时间，
    /// 而用户在 UTC+8 看到的就是一个差了八小时的「请在 X 点后重试」。时长没有时区，谁读都对。
    /// </summary>
    public static string? ResetHint(HttpResponseMessage resp)
    {
        if (!resp.Headers.TryGetValues("X-RateLimit-Reset", out var reset)) return null;
        var first = reset.FirstOrDefault();
        if (first == null || !long.TryParse(first, out var unix)) return null;

        var remaining = DateTimeOffset.FromUnixTimeSeconds(unix) - DateTimeOffset.UtcNow;
        if (remaining <= TimeSpan.Zero) return "约 1 分钟";

        var minutes = (int)Math.Ceiling(remaining.TotalMinutes);
        return minutes >= 60
            ? $"约 {minutes / 60} 小时 {minutes % 60} 分钟"
            : $"约 {minutes} 分钟";
    }
}
