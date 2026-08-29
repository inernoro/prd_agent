using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 退款必须退「当初实际扣的那两个键」，不许退款时再算一遍（Codex 第二十七轮 P2）。
///
/// 站点键把 UTC 日期编在里面（ask-quota:site:{id}:{yyyyMMdd}），访客键靠 TTL 划窗口。
/// 失败请求若跨过 UTC 零点、或访客窗口刚好到期被别的请求重建，退款时重算出来的就是
/// **下一个窗口**的键：减掉的是别人刚攒的那一格，而超额的那一格原封不动留着——
/// 共用的站点闸被凭空放宽，用户自己那格也没退回去，两头都错。
///
/// 判据是结构性的（"退款不许重算键"），而 AskQuotaService 要真 Redis 才跑得起来，
/// 所以这里扫源码。断言钉在方法体内：RefundAsync 里不许出现键构造调用。
/// </summary>
public class AskQuotaRefundKeyTests
{
    private static string Service() => File.ReadAllText(Path.Combine(
        LocateSrcRoot(), "PrdAgent.Infrastructure", "Services", "AskQuotaService.cs"));

    /// <summary>
    /// 取 RefundAsync 的方法体。
    ///
    /// 边界必须找**下一个成员**（任意可见性），不能只找 `\n    public `：
    /// VisitorKey / SiteKey 是 private static，只找 public 的话「方法体」会一路
    /// 延伸到它们的**定义**处，于是断言命中的是定义而不是调用——测试因错误的原因
    /// 变红，和因错误的原因变绿一样糟（第一版就是这么写的，当场误报）。
    /// </summary>
    private static string RefundBody(string src)
    {
        var start = src.IndexOf("public async Task RefundAsync", StringComparison.Ordinal);
        Assert.True(start > 0, "找不到 RefundAsync，测试该跟着改");
        var ends = new[] { "\n    public ", "\n    private ", "\n    internal ", "\n    protected " }
            .Select(m => src.IndexOf(m, start + 10, StringComparison.Ordinal))
            .Where(i => i > start)
            .DefaultIfEmpty(src.Length)
            .Min();
        return src[start..ends];
    }

    [Fact]
    public void 退款不许自己重算键()
    {
        var body = RefundBody(Service());

        Assert.DoesNotContain("VisitorKey(", body);
        Assert.DoesNotContain("SiteKey(", body);
    }

    [Fact]
    public void 退款用的是决定里记下的那两个键()
    {
        var body = RefundBody(Service());

        Assert.Contains("decision.ConsumedVisitorKey", body);
        Assert.Contains("decision.ConsumedSiteKey", body);
    }

    /// <summary>扣成功那条路径必须把键记进决定，否则上面两条就退了个空。</summary>
    [Fact]
    public void 扣成功时必须记下这两个键()
    {
        var src = Service();
        var consume = src[src.IndexOf("public async Task<AskQuotaDecision> TryConsumeAsync", StringComparison.Ordinal)..];
        var head = consume[..Math.Min(consume.Length, 4000)];

        Assert.Matches(new Regex(@"ConsumedVisitorKey\s*=\s*visitorKey"), head);
        Assert.Matches(new Regex(@"ConsumedSiteKey\s*=\s*siteKey"), head);
    }

    /// <summary>
    /// 站点日配额的 TTL 必须对齐 UTC 零点，不能想当然给 24 小时。
    ///
    /// 键名里编了 UTC 日期（...:{yyyyMMdd}），零点一到就换新键、计数自然归零。
    /// TTL 给 24 小时的话，当天第一次提问发生在 10:00 时这个键活到次日 10:00，
    /// 而 Retry-After 取自 TTL——于是前端被告知的重置时刻比真实的晚 10 小时，
    /// 用户额度早就恢复了却还锁着，最坏白等将近一整天。
    /// </summary>
    [Fact]
    public void 站点日配额TTL对齐UTC零点()
    {
        var src = Service();
        var consume = src[src.IndexOf("public async Task<AskQuotaDecision> TryConsumeAsync", StringComparison.Ordinal)..];
        var head = consume[..Math.Min(consume.Length, 4000)];

        // 站点键那一笔不许再用「从现在起 24 小时」
        Assert.DoesNotContain("IncrWithTtlAsync(db, siteKey, TimeSpan.FromDays(1))", head);
        Assert.Contains("TimeUntilNextUtcMidnight()", head);
    }

    private static string LocateSrcRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "prd-api", "src");
            if (Directory.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, "src");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln"))) return candidate;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src"));
    }
}
