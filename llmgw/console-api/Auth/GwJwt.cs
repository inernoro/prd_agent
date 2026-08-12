using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using PrdAgent.LlmGw.Models;

namespace PrdAgent.LlmGw.Auth;

/// <summary>
/// 网关 JWT 签发（HS256，独立密钥，与 MAP 完全隔离）。默认生命周期 7 天，且用后自动续期
/// （见 <see cref="TryRenew"/>）。长 token 不削弱撤销能力：每个已鉴权请求都会用
/// TenantAccess.ResolveAsync 重新校验用户 SecurityVersion / 成员版本 / 租户状态，
/// 改密、禁用、踢出成员在下一次请求即刻生效。
/// </summary>
public sealed class GwJwt
{
    /// <summary>默认会话时长（天）。可用 LlmGwJwt:LifetimeDays 覆盖。</summary>
    public const int DefaultLifetimeDays = 7;

    /// <summary>默认续期间隔（小时）：token 用满这个时长后，下一次请求即自动换发新 token。</summary>
    public const int DefaultRenewAfterHours = 12;

    private readonly byte[] _key;
    private readonly string _issuer;
    private readonly TimeSpan _lifetime;
    private readonly TimeSpan _renewAfter;

    public GwJwt(string secret, string issuer, int lifetimeDays = DefaultLifetimeDays, int renewAfterHours = DefaultRenewAfterHours)
    {
        _key = Encoding.UTF8.GetBytes(secret);
        _issuer = issuer;
        var days = lifetimeDays <= 0 ? DefaultLifetimeDays : Math.Clamp(lifetimeDays, 1, 90);
        _lifetime = TimeSpan.FromDays(days);
        var renewHours = renewAfterHours <= 0 ? DefaultRenewAfterHours : renewAfterHours;
        var renew = TimeSpan.FromHours(renewHours);
        // 续期间隔必须短于生命周期，否则永远等不到续期就先过期了。
        _renewAfter = renew >= _lifetime ? TimeSpan.FromTicks(_lifetime.Ticks / 2) : renew;
    }

    public string Issuer => _issuer;

    public TimeSpan Lifetime => _lifetime;

    public SymmetricSecurityKey SigningKey => new(_key);

    /// <summary>
    /// 这个会话是不是刚由外部身份提供方（MAP 一键登录）证明过身份。
    /// 用于口令自助：持有这种会话的人此刻就能再走一次 SSO，要求旧口令拦不住任何人，
    /// 只会把忘记口令的本人永久锁在外面。用口令登录得到的会话不带这个标记。
    /// </summary>
    public const string FederatedSessionClaim = "fed_session";

    /// <summary>签发 token，返回 (token, 过期时间 UTC)。</summary>
    public (string Token, DateTime ExpiresAt) Issue(
        LlmGwUser user,
        LlmGwTenant? tenant = null,
        LlmGwMembership? membership = null,
        TimeSpan? lifetime = null,
        bool federatedSession = false,
        DateTime? absoluteExpiresAt = null)
    {
        var now = DateTime.UtcNow;
        DateTime expires;
        if (absoluteExpiresAt is { } hardDeadline)
        {
            // 硬截止：到期时刻是**给定的那个绝对时刻**，一秒都不许往后挪。
            // 不能走下面那条 lifetime 路——那里有 5 分钟下限兜底，会把「只剩 2 分钟」
            // 抬成 5 分钟；每 2 分钟续一次就能让联邦会话连同它带的免旧口令特权
            // 无限续命（Codex PR #1364 P1 第二轮：我上一版以为这个下限无害，
            // 在注释里写了「只保证不往后推」却没验，正是它把洞留下了）。
            // 已经过去的截止时刻不能签：expires <= notBefore 会让 JwtSecurityToken 抛异常。
            // 调用方必须在**任何写入之前**就把这种会话挡掉（见 Program.cs 的 FederatedHardDeadline），
            // 走到这里还是过去时刻就是接线错误，明确抛出来，不要悄悄造一个非法 token。
            if (hardDeadline <= now)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(absoluteExpiresAt), hardDeadline,
                    "硬截止已过期，调用方应当拒绝续签而不是签发 token。");
            }
            // 仍然不许超过常规上限（防止传进来一个离谱的远期时刻）。
            var ceiling = now.Add(_lifetime);
            expires = hardDeadline > ceiling ? ceiling : hardDeadline;
        }
        else
        {
            var requestedLifetime = lifetime ?? _lifetime;
            var effectiveLifetime = requestedLifetime > _lifetime ? _lifetime : requestedLifetime;
            if (effectiveLifetime < TimeSpan.FromMinutes(5)) effectiveLifetime = TimeSpan.FromMinutes(5);
            expires = now.Add(effectiveLifetime);
        }

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            new(ClaimTypes.Name, user.Username),
            new(TenantAccess.UserSecurityVersionClaim, user.SecurityVersion.ToString()),
        };

        if (!string.IsNullOrWhiteSpace(user.IdentityProvider))
        {
            claims.Add(new Claim("identity_provider", user.IdentityProvider));
        }

        // 只有经 SSO 换来的会话才带这个标记；续期会原样带过去（会话血统不变）。
        if (federatedSession)
        {
            claims.Add(new Claim(FederatedSessionClaim, "1"));
        }

        // 首登强制改密：带 mcp=1 的 token 只能调 /gw/auth/change-password，服务端策略门（LogsRead）拒绝
        // 其访问 /gw/logs*。改密成功后重新签发的 token 不再带此 claim，方可读日志。
        if (user.MustChangePassword)
        {
            claims.Add(new Claim("mcp", "1"));
        }

        if (tenant is not null && membership is not null)
        {
            claims.Add(new Claim(TenantAccess.TenantClaim, tenant.Id));
            claims.Add(new Claim(TenantAccess.RoleClaim, membership.Role));
            claims.Add(new Claim(TenantAccess.MembershipClaim, membership.Id));
            claims.Add(new Claim(TenantAccess.MembershipVersionClaim, membership.Version.ToString()));
        }

        var creds = new SigningCredentials(SigningKey, SecurityAlgorithms.HmacSha256);
        var token = new JwtSecurityToken(
            issuer: _issuer,
            audience: null,
            claims: claims,
            notBefore: now,
            expires: expires,
            signingCredentials: creds);

        var encoded = new JwtSecurityTokenHandler().WriteToken(token);
        return (encoded, expires);
    }

    /// <summary>
    /// 滑动续期：token 已使用超过续期间隔时换发一枚同身份、重新计时的新 token。
    /// 只续「完整会话时长」签发的 token —— MAP SSO 这类被显式缩短的短会话不会被悄悄拉长。
    /// 返回 null 表示本次无需续期（仍在续期间隔内，或不是完整会话 token）。
    /// </summary>
    public (string Token, DateTime ExpiresAt)? TryRenew(ClaimsPrincipal principal, DateTime? utcNow = null)
    {
        if (principal.Identity?.IsAuthenticated != true) return null;

        var now = utcNow ?? DateTime.UtcNow;
        if (!TryReadUnixClaim(principal, JwtRegisteredClaimNames.Exp, out var expiresAt)) return null;
        if (!TryReadUnixClaim(principal, JwtRegisteredClaimNames.Nbf, out var issuedAt)
            && !TryReadUnixClaim(principal, JwtRegisteredClaimNames.Iat, out issuedAt)) return null;

        // 显式缩短的会话（如 MAP SSO 15 分钟）保持原样，不进入滑动续期。
        var originalLifetime = expiresAt - issuedAt;
        if (originalLifetime < _lifetime) return null;

        if (now - issuedAt < _renewAfter) return null;

        var claims = new List<Claim>();
        foreach (var claim in principal.Claims)
        {
            // 时间戳与 jti 由新 token 重新生成；issuer/audience 由 JwtSecurityToken 构造参数负责。
            if (IsVolatileClaim(claim.Type)) continue;
            claims.Add(new Claim(claim.Type, claim.Value));
        }
        claims.Add(new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")));

        var renewedExpires = now.Add(_lifetime);
        var creds = new SigningCredentials(SigningKey, SecurityAlgorithms.HmacSha256);
        var renewed = new JwtSecurityToken(
            issuer: _issuer,
            audience: null,
            claims: claims,
            notBefore: now,
            expires: renewedExpires,
            signingCredentials: creds);

        return (new JwtSecurityTokenHandler().WriteToken(renewed), renewedExpires);
    }

    /// <summary>
    /// 换发新 token 时必须丢弃、由新 token 重新生成的 claim（时间戳 + jti + iss/aud）。
    /// </summary>
    private static readonly string[] VolatileClaimTypes =
    {
        JwtRegisteredClaimNames.Exp,
        JwtRegisteredClaimNames.Nbf,
        JwtRegisteredClaimNames.Iat,
        JwtRegisteredClaimNames.Jti,
        JwtRegisteredClaimNames.Iss,
        JwtRegisteredClaimNames.Aud,
    };

    /// <summary>
    /// JwtBearer 默认开启入站 claim 映射（MapInboundClaims=true），`exp` 这类短名在 ClaimsPrincipal 里
    /// 可能已经变成 WS-* 长名。所以短名和映射后的长名都要认：漏掉长名会把旧的过期时间当普通 claim
    /// 复制进新 token（出站映射再变回 `exp`），续期反而把有效期打回原样。
    /// </summary>
    private static bool IsVolatileClaim(string claimType)
    {
        foreach (var type in VolatileClaimTypes)
        {
            if (string.Equals(claimType, type, StringComparison.Ordinal)) return true;
            if (JwtSecurityTokenHandler.DefaultInboundClaimTypeMap.TryGetValue(type, out var mapped)
                && string.Equals(claimType, mapped, StringComparison.Ordinal)) return true;
        }
        return false;
    }

    /// <summary>读取 unix 秒时间戳 claim；同样兼容入站映射后的长名。</summary>
    private static bool TryReadUnixClaim(ClaimsPrincipal principal, string type, out DateTime value)
    {
        value = default;
        var raw = principal.FindFirst(type)?.Value;
        if (string.IsNullOrWhiteSpace(raw)
            && JwtSecurityTokenHandler.DefaultInboundClaimTypeMap.TryGetValue(type, out var mapped))
        {
            raw = principal.FindFirst(mapped)?.Value;
        }
        if (string.IsNullOrWhiteSpace(raw) || !long.TryParse(raw, out var seconds)) return false;
        value = DateTimeOffset.FromUnixTimeSeconds(seconds).UtcDateTime;
        return true;
    }
}
