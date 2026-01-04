namespace PrdAgent.Core.Models;

/// <summary>
/// 用户实体
/// </summary>
public class User
{
    /// <summary>
    /// 兼容字段：历史数据可能存在旧的 id 字段；当前系统以 <see cref="UserId"/> 作为 MongoDB 主键（_id）。
    /// </summary>
    public string? Id { get; set; }

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

    /// <summary>
    /// 用户类型：人类/机器人账号（默认人类）。
    /// 说明：机器人账号不允许通过 /auth/login 登录，仅作为群内“可见成员主体”与审计主体存在。
    /// </summary>
    public UserType UserType { get; set; } = UserType.Human;

    /// <summary>
    /// 机器人类型（仅当 <see cref="UserType"/> = Bot 时使用）
    /// </summary>
    public BotKind? BotKind { get; set; }
    
    /// <summary>账号状态</summary>
    public UserStatus Status { get; set; } = UserStatus.Active;
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    /// <summary>最后登录时间</summary>
    public DateTime? LastLoginAt { get; set; }
}
