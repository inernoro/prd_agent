using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Responses;

/// <summary>
/// 登录响应
/// </summary>
public class LoginResponse
{
    /// <summary>访问令牌</summary>
    public string AccessToken { get; set; } = string.Empty;

    /// <summary>刷新令牌</summary>
    public string RefreshToken { get; set; } = string.Empty;

    /// <summary>过期时间（秒）</summary>
    public int ExpiresIn { get; set; }

    /// <summary>用户信息</summary>
    public UserInfo User { get; set; } = new();
}

/// <summary>
/// 用户信息
/// </summary>
public class UserInfo
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public UserRole Role { get; set; }
}

/// <summary>
/// 注册响应
/// </summary>
public class RegisterResponse
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public UserRole Role { get; set; }
    public DateTime CreatedAt { get; set; }
}





