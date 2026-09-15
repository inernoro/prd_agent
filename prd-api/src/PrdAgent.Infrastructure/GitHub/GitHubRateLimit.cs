using System.Net;
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
    /// <summary>
    /// 这次 403/429 是不是限额问题。两种都算：
    ///
    /// - **主限额耗尽**：<c>X-RateLimit-Remaining: 0</c>；
    /// - **二级限额**（短时间打得太快）：403/429 且带 <c>Retry-After</c>，
    ///   此时主配额没用完，Remaining 仍非零——只看 Remaining 会把它判成「无权限」，
    ///   于是提示用户去改仓库权限，而他改什么都没用，正确的动作是等一会儿再来。
    /// </summary>
    public static bool IsExhausted(HttpResponseMessage resp)
        => IsPrimaryExhausted(resp) || IsSecondaryLimited(resp);

    /// <summary>
    /// 还要等多久（「约 12 分钟」）；拿不到就返回 null，由调用方退回泛化文案。
    ///
    /// 给的是**时长**不是时刻：服务端镜像不配时区，格式化出来的 HH:mm:ss 是容器的 UTC 时间，
    /// 而用户在 UTC+8 看到的就是一个差了八小时的「请在 X 点后重试」。时长没有时区，谁读都对。
    ///
    /// 二级限额的 <c>Retry-After</c> 优先：它给的是 GitHub 要求的实际等待时长，
    /// 而此时 <c>X-RateLimit-Reset</c> 指向的是主配额的重置时刻，往往远晚于真正该等的时间。
    /// </summary>
    public static string? ResetHint(HttpResponseMessage resp)
    {
        var wait = RetryAfterDelay(resp) ?? PrimaryResetDelay(resp);
        if (wait is null) return null;
        if (wait <= TimeSpan.Zero) return "约 1 分钟";

        var minutes = (int)Math.Ceiling(wait.Value.TotalMinutes);
        return minutes >= 60
            ? $"约 {minutes / 60} 小时 {minutes % 60} 分钟"
            : $"约 {minutes} 分钟";
    }

    private static bool IsPrimaryExhausted(HttpResponseMessage resp)
    {
        if (!resp.Headers.TryGetValues("X-RateLimit-Remaining", out var remaining)) return false;
        var first = remaining.FirstOrDefault();
        return first != null && int.TryParse(first, out var r) && r == 0;
    }

    /// <summary>二级限额：只在 403 / 429 上认，别的状态码带 Retry-After 是另一回事（例如 503 维护）。</summary>
    private static bool IsSecondaryLimited(HttpResponseMessage resp)
        => (resp.StatusCode == HttpStatusCode.Forbidden || (int)resp.StatusCode == 429)
           && RetryAfterDelay(resp) is not null;

    /// <summary>Retry-After：GitHub 给秒数，规范也允许 HTTP 日期，两种都收。</summary>
    private static TimeSpan? RetryAfterDelay(HttpResponseMessage resp)
    {
        var retryAfter = resp.Headers.RetryAfter;
        if (retryAfter is null) return null;
        if (retryAfter.Delta is { } delta) return delta;
        if (retryAfter.Date is { } date) return date - DateTimeOffset.UtcNow;
        return null;
    }

    private static TimeSpan? PrimaryResetDelay(HttpResponseMessage resp)
    {
        if (!resp.Headers.TryGetValues("X-RateLimit-Reset", out var reset)) return null;
        var first = reset.FirstOrDefault();
        if (first == null || !long.TryParse(first, out var unix)) return null;
        return DateTimeOffset.FromUnixTimeSeconds(unix) - DateTimeOffset.UtcNow;
    }
}
