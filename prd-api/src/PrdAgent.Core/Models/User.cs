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

    /// <summary>用户唯一标识（通过 IIdGenerator 生成）</summary>
    public string UserId { get; set; } = string.Empty;
    
    /// <summary>用户名（登录用）</summary>
    public string Username { get; set; } = string.Empty;
    
    /// <summary>密码哈希</summary>
    public string PasswordHash { get; set; } = string.Empty;
    
    /// <summary>显示名称</summary>
    public string DisplayName { get; set; } = string.Empty;
    
    /// <summary>用户角色</summary>
    public UserRole Role { get; set; } = UserRole.DEV;

    /// <summary>
    /// 管理后台权限用“系统角色”（RBAC-lite），与 <see cref="Role"/>（PM/DEV/QA/ADMIN 的业务语义）解耦。
    /// 为空时由服务端做兼容推断：ADMIN -> admin，其它 -> none。
    /// </summary>
    public string? SystemRoleKey { get; set; }

    /// <summary>
    /// 用户额外放行权限点（在 <see cref="SystemRoleKey"/> 的基础上叠加）。
    /// </summary>
    public List<string>? PermAllow { get; set; }

    /// <summary>
    /// 用户显式禁止权限点（最终从有效权限集合中剔除）。
    /// </summary>
    public List<string>? PermDeny { get; set; }

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

    /// <summary>
    /// 最后操作时间（最后活跃时间）：
    /// - 人类用户：任意“写请求”（POST/PUT/PATCH/DELETE）会 touch
    /// - 机器人用户：每次落库 AI 消息会 touch
    /// 说明：该字段用于“用户列表/管理后台”展示，避免机器人永远没有登录时间。
    /// </summary>
    public DateTime? LastActiveAt { get; set; }

    /// <summary>
    /// 头像文件名（仅文件名，不含路径/域名）。
    /// 客户端应使用“可配置的头像基础 URL”拼接展示（避免把域名写死在数据库/代码中）。
    /// </summary>
    public string? AvatarFileName { get; set; }

    /// <summary>
    /// 是否需要重置密码（首次登录时为 true，重置后变为 false）。
    /// 当此标志为 true 时，登录成功后前端应强制用户修改密码。
    /// </summary>
    public bool MustResetPassword { get; set; } = false;
}
