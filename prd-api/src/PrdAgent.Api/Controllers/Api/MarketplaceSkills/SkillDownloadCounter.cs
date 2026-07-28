using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using PrdAgent.Api.Extensions;

namespace PrdAgent.Api.Controllers.Api.MarketplaceSkills;

/// <summary>
/// 海鲜市场技能下载计数的去重闸。
///
/// 为什么需要它：下载端点（fork）改匿名之后，任何人都能不取回产物地重复 POST，
/// 每次都把 <c>DownloadCount</c> +1 —— 既能刷高「按热度排序」的默认榜单，
/// 也在无成本地制造 Mongo 写入。这里按「技能 + 调用方」做窗口内去重：
/// 窗口内重复调用照常返回下载地址（不影响真实使用），但不再计数。
///
/// 已知边界：去重表在进程内存里，多实例部署时每个实例各有一份，
/// 分布式调用方仍可绕过。这一层挡的是「单个客户端循环刷」这种最廉价的滥用；
/// 真正的按 IP 限流是另一件事，见 doc/debt.skill.role-bundle.md。
///
/// 两个消费方共用本类，避免两处各写一份去重逻辑而漂移：
/// - <c>MarketplaceSkillsController</c>（站内）
/// - <c>MarketplaceSkillsOpenApiController</c>（开放接口）
/// </summary>
public static class SkillDownloadCounter
{
    /// <summary>同一调用方对同一技能的计数去重窗口。</summary>
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(10);

    /// <summary>
    /// 「查了再写」两步之间有窗口：同一客户端并发打进来时，每个请求都可能在任何人
    /// 写入之前读到「没命中」，于是全部判为应当计数，去重形同虚设——而并发重放正是
    /// 这个闸要挡的攻击形态。用一把锁把查+写合成原子操作。
    ///
    /// 锁内只做一次字典读写（纳秒级），且这条路径只在下载端点上，不存在争用问题；
    /// 相比分段锁，一把全局锁更容易证明正确。
    /// </summary>
    private static readonly object Gate = new();

    /// <summary>
    /// 调用方标识：登录用户取 userId，匿名取客户端 IP 的哈希。
    ///
    /// IP 走 <see cref="HttpRequestExtensions.GetAbuseControlClientIp"/> 而不是裸的
    /// <c>RemoteIpAddress</c>：生产是反代 + Docker 网络，裸取到的是上一跳的共享地址，
    /// 那样一个匿名用户下载之后，同一代理后面的所有人都会被压制十分钟，计数反而少记。
    ///
    /// 也不走 GetRealClientIp（无条件采信 X-Real-IP，只适合展示/统计）：这条闸是防刷，
    /// 无条件采信等于让刷榜方每次换个头就绕过窗口。该方法只在对端是我方反代时才采信。
    ///
    /// 哈希后再用：只在内存里当去重键，不落库、不写日志，万一将来被打进日志也不该带出原始 IP。
    /// </summary>
    public static string Fingerprint(HttpContext http, string? userId)
    {
        if (!string.IsNullOrEmpty(userId)) return $"u:{userId}";
        var ip = http.GetAbuseControlClientIp() ?? "unknown";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(ip));
        return $"a:{Convert.ToHexString(hash.AsSpan(0, 8))}";
    }

    /// <summary>窗口内首次调用返回 true（应当计数），重复调用返回 false。线程安全。</summary>
    public static bool ShouldCount(IMemoryCache cache, HttpContext http, string skillId, string? userId)
    {
        var key = $"mkt:dl:{skillId}:{Fingerprint(http, userId)}";
        lock (Gate)
        {
            if (cache.TryGetValue(key, out _)) return false;
            cache.Set(key, true, Window);
            return true;
        }
    }
}
