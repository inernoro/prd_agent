namespace PrdAgent.Core.Models;

/// <summary>
/// 登录时长口径的 SSOT：access token 分钟数、会话滑动天数的默认值与归一化。
///
/// 存在的理由：这两个值散落在 <c>Program.cs</c>（构造 JwtService / AuthSessionService）、
/// <c>AuthController</c>（返回 expiresIn）、<c>MiduoPlanetSsoController</c>（SSO 登录）三处读取，
/// 各自写一套「非法值兜底」必然漂移 —— 曾经出现过 Program.cs 把配置的 0 原样传给 JwtService
/// （签出立刻过期的 token），Controller 那边却按默认 7 天回报 expiresIn，登录即 401。
/// 任何新的读取点都必须走这里的归一化，禁止再写第二套兜底。
/// </summary>
public static class AuthTokenLifetimes
{
    /// <summary>access token 默认时长：7 天（全系统统一口径）。</summary>
    public const int DefaultAccessTokenMinutes = 7 * 24 * 60;

    /// <summary>会话滑动窗口默认天数：7 天。</summary>
    public const int DefaultSessionSlidingDays = 7;

    private const int MinSessionSlidingDays = 1;
    private const int MaxSessionSlidingDays = 90;

    /// <summary>归一化 access token 分钟数：未配置 / 0 / 负数一律回落默认值。</summary>
    public static int NormalizeAccessTokenMinutes(int configuredMinutes)
        => configuredMinutes <= 0 ? DefaultAccessTokenMinutes : configuredMinutes;

    /// <summary>归一化会话滑动天数：非法值回落默认值，并收敛到 [1, 90] 天。</summary>
    public static int NormalizeSessionSlidingDays(int configuredDays)
        => configuredDays <= 0
            ? DefaultSessionSlidingDays
            : Math.Clamp(configuredDays, MinSessionSlidingDays, MaxSessionSlidingDays);

    /// <summary>
    /// 实际生效的 access token 分钟数：**不得长于会话滑动窗口**。
    ///
    /// JWT 校验只看签名、有效期和 tokenVersion，**不查 refresh 会话是否还在**。所以 token
    /// 一旦比窗口活得久，「N 天不用就掉登录」这条策略就没有执行点：用户闲置到窗口过期后回来，
    /// Redis 里的会话键早没了，但手里的 JWT 仍然有效，照样畅通无阻。两个配置项各自独立
    /// （窗口可配 1 天、token 可配 7 天），必须在这里收口，让策略在构造上可执行。
    ///
    /// 默认配置下两者同为 7 天，此方法等价于 <see cref="NormalizeAccessTokenMinutes"/>。
    /// </summary>
    public static int EffectiveAccessTokenMinutes(int configuredMinutes, int configuredSlidingDays)
    {
        var minutes = NormalizeAccessTokenMinutes(configuredMinutes);
        var windowMinutes = NormalizeSessionSlidingDays(configuredSlidingDays) * 24 * 60;
        return Math.Min(minutes, windowMinutes);
    }
}
