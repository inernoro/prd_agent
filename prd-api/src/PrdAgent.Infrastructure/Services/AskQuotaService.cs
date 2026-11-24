using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
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
            _logger.LogWarning(ex, "提问配额：Redis 不可用，本次放行但未扣计数 site={SiteId}", siteId);
            return AskQuotaDecision.FailOpen();
        }

        try
        {
            var isAnonymous = string.IsNullOrWhiteSpace(userId);

            // 第 1 层：来访者频次。
            // 匿名侧用 IP 哈希只是**宽松兜底**——多层反代下 GetRealClientIp 会坍缩到网关 IP
            // （debt.web-hosting.md 已记这笔账），公司内网一人触限会连累同事，所以阈值不敢设太死。
            var visitorKey = VisitorKey(isAnonymous, userId, clientIp);
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
            var siteKey = SiteKey(siteId);
            // TTL 必须对齐**键自己的轮转时刻**，不能想当然给 24 小时。
            //
            // 站点键带 UTC 日期（...:{yyyyMMdd}），零点一到就换成新键、计数自然归零。
            // 而 TTL 给 24 小时的话，当天第一次提问发生在 10:00 时这个键活到次日 10:00,
            // 于是 Retry-After（取自 TTL）比真正的重置时刻晚了 10 小时。前端照着它等，
            // 额度早就恢复了，用户还被锁着——最坏能白等将近一整天。
            var siteCount = await IncrWithTtlAsync(db, siteKey, TimeUntilNextUtcMidnight());
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

            // 记下**这一次真正扣在哪两个键**上。退款时原样退回去，不重算——
            // 重算会在跨 UTC 零点 / 访客窗口翻篇时算出下一个窗口的键，
            // 减掉别人刚攒的那格，而超额那格留着不动。
            var ok = AskQuotaDecision.Ok();
            ok.ConsumedVisitorKey = visitorKey;
            ok.ConsumedSiteKey = siteKey;
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "提问配额：判定异常，本次放行但未必扣上 site={SiteId}", siteId);
            return AskQuotaDecision.FailOpen();
        }
    }

    public async Task<AskQuotaSnapshot?> PeekAsync(
        string siteId, string? userId, string? clientIp, int siteDailyLimit, CancellationToken ct = default)
    {
        try
        {
            var db = _redis.GetDatabase();
            var isAnonymous = string.IsNullOrWhiteSpace(userId);
            // 键与阈值都复用 TryConsumeAsync 那一套，不另写一份 —— 两份迟早对不上，
            // 而对不上的表现是「面板说还剩 5 次，第 1 次就被拒」，比不显示更伤信任。
            var visitorKey = VisitorKey(isAnonymous, userId, clientIp);
            var siteKey = SiteKey(siteId);

            // StringGet 不存在时返回 null，转成 0：窗口还没开始就是一次都没用
            var visitorUsed = (int?)await db.StringGetAsync(visitorKey) ?? 0;
            var siteUsed = (int?)await db.StringGetAsync(siteKey) ?? 0;

            return new AskQuotaSnapshot
            {
                VisitorUsed = visitorUsed,
                VisitorLimit = isAnonymous ? AnonymousHourlyLimit : VisitorHourlyLimit,
                SiteUsed = siteUsed,
                SiteLimit = siteDailyLimit > 0 ? siteDailyLimit : DefaultSiteDailyLimit,
            };
        }
        catch (Exception ex)
        {
            // 读不到就**不显示**，不是显示一个猜的数（no-rootless-tree）
            _logger.LogWarning(ex, "提问配额：读取快照失败，本次不显示剩余数 site={SiteId}", siteId);
            return null;
        }
    }

    public async Task RefundAsync(
        AskQuotaDecision decision, string siteId, CancellationToken ct = default)
    {
        // 没扣成就没什么可退（FailOpen / 被拒的那两条路都不带键）。
        // 这里也不兜底去重算键——算不出「当初扣的是哪个窗口」时，宁可不退：
        // 退错窗口是把别人的用量抹掉，比这个用户少一格额度严重得多。
        if (string.IsNullOrEmpty(decision.ConsumedVisitorKey) && string.IsNullOrEmpty(decision.ConsumedSiteKey))
        {
            return;
        }

        try
        {
            var db = _redis.GetDatabase();

            // 只在计数为正时回退，避免窗口刚好翻篇后把计数减成负数。
            // 键取自 decision——就是 TryConsumeAsync 当初 INCR 的那两个。
            if (!string.IsNullOrEmpty(decision.ConsumedVisitorKey)) await DecrIfPositiveAsync(db, decision.ConsumedVisitorKey);
            if (!string.IsNullOrEmpty(decision.ConsumedSiteKey)) await DecrIfPositiveAsync(db, decision.ConsumedSiteKey);
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

    // ── key 构造：占用与回退必须用同一把尺子，所以只许有这两个方法 ──
    //
    // 全部经 DeploymentScope.ScopeIdempotencyKey 盖作用域：CDS 分支预览与生产**共用同一个
    // Redis**（cross-project-isolation 通道 4），站点 ID 也是同一个。不盖作用域的话，
    // 在预览里点几下提问就会吃掉生产那条分享的当日额度，把线上刷成 QUOTA_EXCEEDED。
    // 生产环境 Current 为 null，key 原样保留，不影响存量计数。

    private static string VisitorKey(bool isAnonymous, string? userId, string? clientIp)
        => DeploymentScope.ScopeIdempotencyKey(
            isAnonymous ? $"ask-quota:anon:{HashIp(clientIp)}" : $"ask-quota:user:{userId}");

    /// <summary>
    /// 距离下一个 UTC 零点还有多久——站点日配额键的真实存活期。
    ///
    /// 键名里编了 UTC 日期，零点换键即归零；所以 TTL 和据此算出的 Retry-After
    /// 都必须以零点为准，而不是「从现在起 24 小时」。
    /// </summary>
    private static TimeSpan TimeUntilNextUtcMidnight()
    {
        var now = DateTime.UtcNow;
        return now.Date.AddDays(1) - now;
    }

    private static string SiteKey(string siteId)
        => DeploymentScope.ScopeIdempotencyKey($"ask-quota:site:{siteId}:{DateTime.UtcNow:yyyyMMdd}");

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
