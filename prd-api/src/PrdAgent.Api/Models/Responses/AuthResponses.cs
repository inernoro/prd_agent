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

    /// <summary>会话键（用于 refresh 与多端独立计时）</summary>
    public string SessionKey { get; set; } = string.Empty;

    /// <summary>客户端类型：admin/desktop</summary>
    public string ClientType { get; set; } = string.Empty;

    /// <summary>过期时间（秒）</summary>
    public int ExpiresIn { get; set; }

    /// <summary>用户信息</summary>
    public UserInfo User { get; set; } = new();

    /// <summary>是否需要重置密码（首次登录时为 true）</summary>
    public bool MustResetPassword { get; set; } = false;
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
    /// <summary>用户类型：Human/Bot</summary>
    public UserType UserType { get; set; } = UserType.Human;
    /// <summary>机器人类型（仅当 UserType=Bot 时有值）</summary>
    public BotKind? BotKind { get; set; }
    /// <summary>头像文件名（仅文件名，不含路径/域名）</summary>
    public string? AvatarFileName { get; set; }
    /// <summary>头像可直接渲染的 URL（服务端拼好）</summary>
    public string? AvatarUrl { get; set; }
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
