using System.Security.Claims;
using PrdAgent.Api.Services;

namespace PrdAgent.Api.Authentication;

/// <summary>
/// 外部控制台只能继承真人管理后台会话。合成测试会话即使绑定管理员账号，
/// 也不得换取生命周期更长的跨系统票据或会话。
/// </summary>
public static class FederatedConsoleSessionPolicy
{
    public const string SyntheticAuthType = "synthetic-test";

    public static bool IsSynthetic(ClaimsPrincipal user)
        => string.Equals(
            user.FindFirst("authType")?.Value,
            SyntheticAuthType,
            StringComparison.Ordinal);

    public static bool IsEligibleBrowserSession(ClaimsPrincipal user)
        => !IsSynthetic(user)
           && !CdsSsoSessions.IsDelegated(user.FindFirst("sessionKey")?.Value)
           && string.IsNullOrWhiteSpace(user.FindFirst("authType")?.Value)
           && string.Equals(user.FindFirst("clientType")?.Value, "admin", StringComparison.Ordinal)
           && !string.IsNullOrWhiteSpace(user.FindFirst("sessionKey")?.Value);
}
