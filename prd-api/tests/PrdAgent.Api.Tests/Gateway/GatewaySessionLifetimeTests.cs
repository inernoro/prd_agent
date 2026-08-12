using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.IdentityModel.Tokens;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 网关控制台登录有效期：默认 7 天 + 用后自动续期（滑动窗口），
/// 且显式缩短的会话（MAP SSO 这类联邦短会话）不得被悄悄拉长。
/// </summary>
public sealed class GatewaySessionLifetimeTests
{
    private const string Secret = "llmgw-test-secret-at-least-32-bytes-long!!";
    private const string Issuer = "prdagent-llmgw-test";

    private static LlmGwUser BuildUser() => new()
    {
        Id = "user-1",
        Username = "alice",
        DisplayName = "Alice",
        SecurityVersion = 3,
        IsActive = true,
    };

    private static LlmGwTenant BuildTenant() => new() { Id = "tenant-1", Name = "Tenant One", Status = "active" };

    private static LlmGwMembership BuildMembership() => new()
    {
        Id = "membership-1",
        TenantId = "tenant-1",
        UserId = "user-1",
        Role = LlmGwTenantRoles.Owner,
        Status = "active",
        Version = 5,
    };

    /// <summary>把签发的 token 还原成 ClaimsPrincipal，模拟 JwtBearer 校验后的请求上下文。</summary>
    private static ClaimsPrincipal ReadPrincipal(GwJwt jwt, string token)
    {
        var handler = new JwtSecurityTokenHandler();
        return handler.ValidateToken(token, new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = Issuer,
            ValidateAudience = false,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = jwt.SigningKey,
            // 续期场景要读「已经用了一段时间」的 token，这里不校验时间窗。
            ValidateLifetime = false,
        }, out _);
    }

    [Fact]
    public void Issue_DefaultsToSevenDayLifetime()
    {
        var jwt = new GwJwt(Secret, Issuer);
        var (_, expiresAt) = jwt.Issue(BuildUser(), BuildTenant(), BuildMembership());

        (expiresAt - DateTime.UtcNow).TotalDays.ShouldBeInRange(6.9, 7.01);
    }

    [Fact]
    public void TryRenew_ReturnsNullWhileTokenIsStillFresh()
    {
        var jwt = new GwJwt(Secret, Issuer);
        var (token, _) = jwt.Issue(BuildUser(), BuildTenant(), BuildMembership());

        jwt.TryRenew(ReadPrincipal(jwt, token)).ShouldBeNull();
    }

    [Fact]
    public void TryRenew_IssuesFreshTokenAfterRenewIntervalAndKeepsIdentityClaims()
    {
        var jwt = new GwJwt(Secret, Issuer);
        var (token, _) = jwt.Issue(BuildUser(), BuildTenant(), BuildMembership());
        var principal = ReadPrincipal(jwt, token);

        // 模拟「用了 3 天之后又来请求」：应换发一枚重新计时的 token。
        var renewed = jwt.TryRenew(principal, DateTime.UtcNow.AddDays(3));

        renewed.ShouldNotBeNull();
        (renewed!.Value.ExpiresAt - DateTime.UtcNow.AddDays(3)).TotalDays.ShouldBeInRange(6.9, 7.01);

        var renewedPrincipal = ReadPrincipal(jwt, renewed.Value.Token);
        renewedPrincipal.FindFirst(ClaimTypes.NameIdentifier)?.Value.ShouldBe("user-1");
        renewedPrincipal.FindFirst(ClaimTypes.Name)?.Value.ShouldBe("alice");
        renewedPrincipal.FindFirst(TenantAccess.TenantClaim)?.Value.ShouldBe("tenant-1");
        renewedPrincipal.FindFirst(TenantAccess.MembershipClaim)?.Value.ShouldBe("membership-1");
        renewedPrincipal.FindFirst(TenantAccess.MembershipVersionClaim)?.Value.ShouldBe("5");
        renewedPrincipal.FindFirst(TenantAccess.UserSecurityVersionClaim)?.Value.ShouldBe("3");
        // jti 必须换新，避免新旧 token 共用同一个标识（直接读原始 token，绕开 claim 映射）。
        var handler = new JwtSecurityTokenHandler();
        var renewedJti = handler.ReadJwtToken(renewed.Value.Token).Id;
        renewedJti.ShouldNotBeNullOrWhiteSpace();
        renewedJti.ShouldNotBe(handler.ReadJwtToken(token).Id);
    }

    [Fact]
    public void TryRenew_PreservesMustChangePasswordGate()
    {
        var jwt = new GwJwt(Secret, Issuer);
        var user = BuildUser();
        user.MustChangePassword = true;
        var (token, _) = jwt.Issue(user, BuildTenant(), BuildMembership());

        var renewed = jwt.TryRenew(ReadPrincipal(jwt, token), DateTime.UtcNow.AddDays(3));

        renewed.ShouldNotBeNull();
        ReadPrincipal(jwt, renewed!.Value.Token).HasClaim(c => c.Type == "mcp" && c.Value == "1").ShouldBeTrue();
    }

    [Fact]
    public void TryRenew_DoesNotExtendExplicitlyShortenedSessions()
    {
        var jwt = new GwJwt(Secret, Issuer);
        // MAP SSO 可被配置成 15 分钟联邦会话；这种短会话不进滑动续期，否则等于偷偷放宽策略。
        var (token, _) = jwt.Issue(BuildUser(), BuildTenant(), BuildMembership(), TimeSpan.FromMinutes(15));

        jwt.TryRenew(ReadPrincipal(jwt, token), DateTime.UtcNow.AddDays(3)).ShouldBeNull();
    }

    [Fact]
    public void RenewInterval_NeverExceedsLifetime()
    {
        // 配置失误（续期间隔 > 生命周期）时必须自动收敛，否则永远等不到续期就先过期。
        var jwt = new GwJwt(Secret, Issuer, lifetimeDays: 1, renewAfterHours: 240);
        var (token, _) = jwt.Issue(BuildUser(), BuildTenant(), BuildMembership());

        jwt.TryRenew(ReadPrincipal(jwt, token), DateTime.UtcNow.AddHours(13)).ShouldNotBeNull();
    }

    [Fact]
    public void Issue_WithAbsoluteDeadline_IsNotLiftedByTheFiveMinuteFloor()
    {
        // 这条钉的是那个 5 分钟下限**不许**作用在硬截止上。
        //
        // 联邦会话（fed_session）带着「免旧口令改密」的特权，它的边界就是到期时刻。
        // 续签走 lifetime 时，下限会把「只剩 2 分钟」抬成 5 分钟——每 2 分钟续一次
        // 就能把特权无限续下去。所以硬截止必须原样落在 exp 上，一秒都不许往后挪
        // （Codex PR #1364 P1 第二轮；我上一版误以为这个下限无害，正是它把洞留下的）。
        var jwt = new GwJwt(Secret, Issuer, lifetimeDays: 7, renewAfterHours: 24);
        var deadline = DateTime.UtcNow.AddMinutes(2);

        var (token, expiresAt) = jwt.Issue(
            BuildUser(), BuildTenant(), BuildMembership(), federatedSession: true, absoluteExpiresAt: deadline);

        // 允许一秒级误差（JWT 的 exp 精度到秒），但绝不允许被抬到 5 分钟。
        expiresAt.ShouldBeLessThan(DateTime.UtcNow.AddMinutes(3));
        var exp = ReadPrincipal(jwt, token).FindFirst(JwtRegisteredClaimNames.Exp)!.Value;
        var expUtc = DateTimeOffset.FromUnixTimeSeconds(long.Parse(exp)).UtcDateTime;
        (expUtc - deadline).Duration().ShouldBeLessThan(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public void Issue_WithoutAbsoluteDeadline_StillFloorsShortLifetimes()
    {
        // 反面：不传硬截止时，原来的 5 分钟下限行为保持不变——
        // 上一条不是把下限删了，而是让它不作用在硬截止那条路上。
        var jwt = new GwJwt(Secret, Issuer, lifetimeDays: 7, renewAfterHours: 24);

        var (_, expiresAt) = jwt.Issue(
            BuildUser(), BuildTenant(), BuildMembership(), lifetime: TimeSpan.FromMinutes(2));

        expiresAt.ShouldBeGreaterThan(DateTime.UtcNow.AddMinutes(4));
    }
}
