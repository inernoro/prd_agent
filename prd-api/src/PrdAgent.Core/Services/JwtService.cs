using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// JWT服务实现
/// </summary>
public class JwtService : IJwtService
{
    private readonly string _secret;
    private readonly string _issuer;
    private readonly string _audience;
    private readonly int _accessTokenMinutes;

    public JwtService(string secret, string issuer, string audience, int accessTokenMinutes = 60)
    {
        _secret = secret;
        _issuer = issuer;
        _audience = audience;
        _accessTokenMinutes = accessTokenMinutes;
    }

    public string GenerateAccessToken(User user, string clientType, string sessionKey, int tokenVersion)
    {
        var securityKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_secret));
        var credentials = new SigningCredentials(securityKey, SecurityAlgorithms.HmacSha256);

        var ct = (clientType ?? string.Empty).Trim().ToLowerInvariant();
        if (ct is not "admin" and not "desktop")
        {
            // 兜底：避免写入非法 clientType，影响后续滑动续期/版本校验
            ct = "desktop";
        }
        var sk = (sessionKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sk))
        {
            sk = Guid.NewGuid().ToString("N");
        }

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.UserId),
            new(JwtRegisteredClaimNames.UniqueName, user.Username),
            new("displayName", user.DisplayName),
            new("role", user.Role.ToString()),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            new("clientType", ct),
            new("sessionKey", sk),
            new("tv", tokenVersion.ToString())
        };

        // root 破窗账户：标记在 token 中，供授权层兜底放行（不依赖 DB）
        if (string.Equals(user.UserId, "root", StringComparison.Ordinal))
        {
            claims.Add(new Claim("isRoot", "1"));
        }

        var token = new JwtSecurityToken(
            issuer: _issuer,
            audience: _audience,
            claims: claims,
            expires: DateTime.UtcNow.AddMinutes(_accessTokenMinutes),
            signingCredentials: credentials);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    public string GenerateRefreshToken()
    {
        var randomBytes = new byte[64];
        using var rng = RandomNumberGenerator.Create();
        rng.GetBytes(randomBytes);
        return Convert.ToBase64String(randomBytes);
    }

    public JwtValidationResult ValidateToken(string token)
    {
        try
        {
            var tokenHandler = new JwtSecurityTokenHandler();
            // 禁用默认的 claim 类型映射，保持原始 JWT claim 名称
            tokenHandler.MapInboundClaims = false;
            
            var key = Encoding.UTF8.GetBytes(_secret);

            var validationParameters = new TokenValidationParameters
            {
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = new SymmetricSecurityKey(key),
                ValidateIssuer = true,
                ValidIssuer = _issuer,
                ValidateAudience = true,
                ValidAudience = _audience,
                ValidateLifetime = true,
                ClockSkew = TimeSpan.Zero
            };

            var principal = tokenHandler.ValidateToken(token, validationParameters, out _);
            
            var userId = principal.FindFirst(JwtRegisteredClaimNames.Sub)?.Value;
            var username = principal.FindFirst(JwtRegisteredClaimNames.UniqueName)?.Value;
            var roleStr = principal.FindFirst("role")?.Value;
            
            Enum.TryParse<UserRole>(roleStr, out var role);

            return new JwtValidationResult
            {
                IsValid = true,
                UserId = userId,
                Username = username,
                Role = role
            };
        }
        catch (Exception ex)
        {
            return new JwtValidationResult
            {
                IsValid = false,
                ErrorMessage = ex.Message
            };
        }
    }

    public string? GetUserIdFromToken(string token)
    {
        try
        {
            var tokenHandler = new JwtSecurityTokenHandler();
            var jwtToken = tokenHandler.ReadJwtToken(token);
            return jwtToken.Claims.FirstOrDefault(c => c.Type == JwtRegisteredClaimNames.Sub)?.Value;
        }
        catch
        {
            return null;
        }
    }
}

