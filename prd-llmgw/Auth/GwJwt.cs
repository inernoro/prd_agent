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
