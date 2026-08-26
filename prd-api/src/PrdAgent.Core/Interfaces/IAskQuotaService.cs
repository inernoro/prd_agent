namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 「向我提问」的配额闸。
///
/// 为什么不复用现有的 RateLimitMiddleware：那个只数请求数，而提问的成本单位是 token 和钱。
/// 一个开了匿名提问的公开页面被刷，站点 owner 是要付账的，所以这里除了频次还要有
/// **站点级日上限**这一层——它保护的是 owner 的钱包，不是服务器的 CPU。
/// </summary>
public interface IAskQuotaService
{
    /// <summary>
    /// 提问前检查并占用配额。放行返回 Allowed=true；超限返回原因与建议等待时间。
    ///
    /// 三层闸依次判定，任一超限即拒绝：
    ///   1. 来访者频次（登录按 userId、匿名按 IP 哈希）—— 防单人刷屏
    ///   2. 站点日上限 —— 防单个站点烧光 owner 的预算
    /// </summary>
    Task<AskQuotaDecision> TryConsumeAsync(
        string siteId, string? userId, string? clientIp, int siteDailyLimit, CancellationToken ct = default);

    /// <summary>
    /// 只读地看一眼还剩多少，**不消耗**任何一格。
    ///
    /// 给面板初始化用：不告诉访客还能问几次，他只能问到被拒才知道有上限
    /// （预期管理：任何时候都该知道自己还能做多少）。
    ///
    /// 读不到（Redis 不可用）时返回 null，让调用方**什么都不显示**——
    /// 这里绝不能编一个数出来：配额是会让用户改变行为的信息，编错了比不显示更糟。
    /// </summary>
    Task<AskQuotaSnapshot?> PeekAsync(
        string siteId, string? userId, string? clientIp, int siteDailyLimit, CancellationToken ct = default);

    /// <summary>
    /// 把已占用的一次配额退回去。
    ///
    /// 用在「占了额度但最终一个字都没问出去」的分叉上——最典型的是对象存储暂时读不到正文：
    /// 这种请求根本没碰上游模型、没花一分钱，却把来访者和站点的计数各加了一次。
    /// 存储抖动期间用户反复重试，额度会被白白烧光，等存储恢复了反而问不了了。
    ///
    /// 仍然保留「先占后退」而不是「后占」：快照构建要读对象存储，本身有成本，
    /// 先占额度才挡得住匿名连打。
    /// </summary>
    Task RefundAsync(
        string siteId, string? userId, string? clientIp, CancellationToken ct = default);
}

/// <summary>还剩多少的只读快照。已用数可能超过上限（拒绝之后计数仍在窗口里），故剩余数要夹到 0。</summary>
public class AskQuotaSnapshot
{
    /// <summary>这个站点今天已用 / 上限</summary>
    public int SiteUsed { get; set; }
    public int SiteLimit { get; set; }

    /// <summary>这个访客本小时已用 / 上限</summary>
    public int VisitorUsed { get; set; }
    public int VisitorLimit { get; set; }

    public int SiteRemaining => Math.Max(0, SiteLimit - SiteUsed);
    public int VisitorRemaining => Math.Max(0, VisitorLimit - VisitorUsed);
}

public class AskQuotaDecision
{
    public bool Allowed { get; set; }

    /// <summary>拒绝原因（给用户看的中文，已含具体数字）</summary>
    public string? Reason { get; set; }

    /// <summary>建议多久后重试（秒）</summary>
    public int? RetryAfterSeconds { get; set; }

    /// <summary>命中的是哪一层闸：visitor | site-daily</summary>
    public string? Scope { get; set; }

    public static AskQuotaDecision Ok() => new() { Allowed = true };
}
