using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 管理后台的"系统角色"（RBAC-lite）：用于分配权限点（permission strings）。
/// 注意：它与 <see cref="UserRole"/>（PM/DEV/QA/ADMIN 的业务语义）解耦。
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
public class SystemRole
{
    /// <summary>主键（MongoDB _id）</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>唯一 key（如 admin/operator/viewer/none）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>展示名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>权限点列表</summary>
    public List<string> Permissions { get; set; } = new();

    /// <summary>是否内置（内置角色不可删除；是否允许编辑由后端控制）</summary>
    public bool IsBuiltIn { get; set; } = true;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string? UpdatedBy { get; set; }
}

