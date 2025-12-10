using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// JWT服务接口
/// </summary>
public interface IJwtService
{
    /// <summary>生成访问令牌</summary>
    string GenerateAccessToken(User user);
    
    /// <summary>生成刷新令牌</summary>
    string GenerateRefreshToken();
    
    /// <summary>验证访问令牌</summary>
    JwtValidationResult ValidateToken(string token);
    
    /// <summary>从令牌获取用户ID</summary>
    string? GetUserIdFromToken(string token);
}

/// <summary>
/// JWT验证结果
/// </summary>
public class JwtValidationResult
{
    public bool IsValid { get; set; }
    public string? UserId { get; set; }
    public string? Username { get; set; }
    public UserRole? Role { get; set; }
    public string? ErrorMessage { get; set; }
}



