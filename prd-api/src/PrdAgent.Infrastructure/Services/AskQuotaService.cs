using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using StackExchange.Redis;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 配额闸的 Redis 实现：INCR + 首次 EXPIRE 的经典计数窗口。
///
/// 失败策略是**放行**（fail-open）：Redis 挂了不该让所有人都问不了问题。
/// 这一层是防滥用而不是防攻击，真正的兜底是站点 owner 能随时关掉提问开关。
/// </summary>
public class AskQuotaService : IAskQuotaService
{
    /// <summary>登录用户：每小时上限</summary>
    private const int VisitorHourlyLimit = 30;

    /// <summary>匿名访客：每小时上限（比登录用户紧，因为身份不可靠）</summary>
    private const int AnonymousHourlyLimit = 10;

    /// <summary>站点日上限的系统默认值（owner 没设 AskDailyLimit 时用它）</summary>
    private const int DefaultSiteDailyLimit = 200;

    private readonly ConnectionMultiplexer _redis;
    private readonly ILogger<AskQuotaService> _logger;

    public AskQuotaService(ConnectionMultiplexer redis, ILogger<AskQuotaService> logger)
    {
        _redis = redis;
        _logger = logger;
    }

    public async Task<AskQuotaDecision> TryConsumeAsync(
        string siteId, string? userId, string? clientIp, int siteDailyLimit, CancellationToken ct = default)
    {
        IDatabase db;
        try
        {
            db = _redis.GetDatabase();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "提问配额：Redis 不可用，本次放行 site={SiteId}", siteId);
            return AskQuotaDecision.Ok();
        }

        try
        {
            var isAnonymous = string.IsNullOrWhiteSpace(userId);

            // 第 1 层：来访者频次。
            // 匿名侧用 IP 哈希只是**宽松兜底**——多层反代下 GetRealClientIp 会坍缩到网关 IP
            // （debt.web-hosting.md 已记这笔账），公司内网一人触限会连累同事，所以阈值不敢设太死。
            var visitorKey = isAnonymous
                ? $"ask-quota:anon:{HashIp(clientIp)}"
                : $"ask-quota:user:{userId}";
            var visitorLimit = isAnonymous ? AnonymousHourlyLimit : VisitorHourlyLimit;

            var visitorCount = await IncrWithTtlAsync(db, visitorKey, TimeSpan.FromHours(1));
            if (visitorCount > visitorLimit)
            {
                var ttl = await db.KeyTimeToLiveAsync(visitorKey);
                return new AskQuotaDecision
                {
                    Allowed = false,
                    Scope = "visitor",
                    Reason = $"提问太频繁了，每小时最多 {visitorLimit} 次，请稍后再问。",
                    RetryAfterSeconds = (int?)ttl?.TotalSeconds ?? 600,
                };
            }

            // 第 2 层：站点日上限，保护 owner 的账单。
            var effectiveDaily = siteDailyLimit > 0 ? siteDailyLimit : DefaultSiteDailyLimit;
            var siteKey = $"ask-quota:site:{siteId}:{DateTime.UtcNow:yyyyMMdd}";
            var siteCount = await IncrWithTtlAsync(db, siteKey, TimeSpan.FromDays(1));
            if (siteCount > effectiveDaily)
            {
                var ttl = await db.KeyTimeToLiveAsync(siteKey);
                return new AskQuotaDecision
                {
                    Allowed = false,
                    Scope = "site-daily",
                    Reason = $"这个页面今天的提问次数已达上限（{effectiveDaily} 次），明天再来吧。",
                    RetryAfterSeconds = (int?)ttl?.TotalSeconds ?? 3600,
                };
            }

            return AskQuotaDecision.Ok();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "提问配额：判定异常，本次放行 site={SiteId}", siteId);
            return AskQuotaDecision.Ok();
        }
    }

    public async Task RefundAsync(
        string siteId, string? userId, string? clientIp, CancellationToken ct = default)
    {
        try
        {
            var db = _redis.GetDatabase();
            var isAnonymous = string.IsNullOrWhiteSpace(userId);
            var visitorKey = isAnonymous
                ? $"ask-quota:anon:{HashIp(clientIp)}"
                : $"ask-quota:user:{userId}";
            var siteKey = $"ask-quota:site:{siteId}:{DateTime.UtcNow:yyyyMMdd}";

            // 只在计数为正时回退，避免窗口刚好翻篇后把计数减成负数
            await DecrIfPositiveAsync(db, visitorKey);
            await DecrIfPositiveAsync(db, siteKey);
        }
        catch (Exception ex)
        {
            // 退不回去不该让请求失败——它只是让用户这次多花了一格额度
            _logger.LogWarning(ex, "提问配额：回退失败 site={SiteId}", siteId);
        }
    }

    private static async Task DecrIfPositiveAsync(IDatabase db, string key)
    {
        var current = await db.StringGetAsync(key);
        if (current.HasValue && current.TryParse(out long n) && n > 0)
            await db.StringDecrementAsync(key);
    }

    /// <summary>
    /// INCR 后仅在"这是本窗口第一次"时设过期。
    /// 每次都 EXPIRE 会让窗口被持续续命，一个高频用户永远滚不出窗口。
    /// </summary>
    private static async Task<long> IncrWithTtlAsync(IDatabase db, string key, TimeSpan window)
    {
        var count = await db.StringIncrementAsync(key);
        if (count == 1)
            await db.KeyExpireAsync(key, window);
        return count;
    }

    /// <summary>IP 只以哈希形式落进 key，不明文存 —— 计数不需要知道具体是谁。</summary>
    private static string HashIp(string? ip)
    {
        if (string.IsNullOrWhiteSpace(ip)) return "unknown";
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(ip));
        return Convert.ToHexString(bytes, 0, 8).ToLowerInvariant();
    }
}
