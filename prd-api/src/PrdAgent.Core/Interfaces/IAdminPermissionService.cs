using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IAdminPermissionService
{
    /// <summary>
    /// 计算管理后台有效权限（system role + allow - deny）。
    /// isRoot=true 时应返回全权限。
    /// </summary>
    Task<IReadOnlyList<string>> GetEffectivePermissionsAsync(string userId, bool isRoot, CancellationToken ct = default);

    /// <summary>
    /// 读取用户的后台权限配置快照（用于管理页面展示）。
    /// </summary>
    Task<AdminUserAuthzSnapshot?> GetUserAuthzSnapshotAsync(string userId, CancellationToken ct = default);
}

public sealed class AdminUserAuthzSnapshot
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public UserRole Role { get; set; }

    public string EffectiveSystemRoleKey { get; set; } = string.Empty;
    public string? SystemRoleKey { get; set; }
    public List<string> PermAllow { get; set; } = new();
    public List<string> PermDeny { get; set; } = new();
}

