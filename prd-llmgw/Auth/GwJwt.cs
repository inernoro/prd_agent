using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using PrdAgent.LlmGw.Models;

namespace PrdAgent.LlmGw.Auth;

/// <summary>
/// 网关 JWT 签发（HS256，独立密钥，与 MAP 完全隔离）。生命周期 12 小时。
/// </summary>
public sealed class GwJwt
{
    private readonly byte[] _key;
    private readonly string _issuer;
    private static readonly TimeSpan Lifetime = TimeSpan.FromHours(12);

    public GwJwt(string secret, string issuer)
    {
        _key = Encoding.UTF8.GetBytes(secret);
        _issuer = issuer;
    }

    public string Issuer => _issuer;

    public SymmetricSecurityKey SigningKey => new(_key);

    /// <summary>签发 token，返回 (token, 过期时间 UTC)。</summary>
    public (string Token, DateTime ExpiresAt) Issue(LlmGwUser user)
    {
        var now = DateTime.UtcNow;
        var expires = now.Add(Lifetime);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            new(ClaimTypes.Name, user.Username),
        };

        // 首登强制改密：带 mcp=1 的 token 只能调 /gw/auth/change-password，服务端策略门（LogsRead）拒绝
        // 其访问 /gw/logs*。改密成功后重新签发的 token 不再带此 claim，方可读日志。
        if (user.MustChangePassword)
        {
            claims.Add(new Claim("mcp", "1"));
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
}
