namespace PrdAgent.Core.Models;

/// <summary>
/// 用户实体
/// </summary>
public class User
{
    /// <summary>用户唯一标识</summary>
    public string UserId { get; set; } = Guid.NewGuid().ToString();
    
    /// <summary>用户名（登录用）</summary>
    public string Username { get; set; } = string.Empty;
    
    /// <summary>密码哈希</summary>
    public string PasswordHash { get; set; } = string.Empty;
    
    /// <summary>显示名称</summary>
    public string DisplayName { get; set; } = string.Empty;
    
    /// <summary>用户角色</summary>
    public UserRole Role { get; set; } = UserRole.DEV;
    
    /// <summary>账号状态</summary>
    public UserStatus Status { get; set; } = UserStatus.Active;
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    /// <summary>最后登录时间</summary>
    public DateTime? LastLoginAt { get; set; }
}


