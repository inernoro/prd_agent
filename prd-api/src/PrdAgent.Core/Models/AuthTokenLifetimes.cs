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
}
