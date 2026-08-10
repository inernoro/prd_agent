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
