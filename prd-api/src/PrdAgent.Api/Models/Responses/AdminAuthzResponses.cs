using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Models.Responses;

public sealed class AdminAuthzMeResponse
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public UserRole Role { get; set; }

    public bool IsRoot { get; set; }
    public string SystemRoleKey { get; set; } = string.Empty;
    public List<string> EffectivePermissions { get; set; } = new();
}

public sealed class SystemRoleDto
{
    public string Id { get; set; } = string.Empty;
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public List<string> Permissions { get; set; } = new();
    public bool IsBuiltIn { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string? UpdatedBy { get; set; }
}

public sealed class UpsertSystemRoleRequest
{
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public List<string>? Permissions { get; set; }
}

public sealed class UpdateUserAuthzRequest
{
    public string? SystemRoleKey { get; set; }
    public List<string>? PermAllow { get; set; }
    public List<string>? PermDeny { get; set; }
}

public sealed class AdminPermissionCatalogResponse
{
    public List<AdminPermissionDef> Items { get; set; } = new();
}

public sealed class AdminMenuCatalogResponse
{
    public List<AdminMenuItemResponse> Items { get; set; } = new();
}

public sealed class AdminMenuItemResponse
{
    /// <summary>
    /// 应用标识，对应后端 Controller 路由前缀
    /// </summary>
    public string AppKey { get; set; } = string.Empty;

    /// <summary>
    /// 前端路由路径
    /// </summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>
    /// 菜单显示名称
    /// </summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>
    /// 菜单描述
    /// </summary>
    public string? Description { get; set; }

    /// <summary>
    /// 图标名称（Lucide icon name）
    /// </summary>
    public string Icon { get; set; } = string.Empty;

    /// <summary>
    /// 进入该菜单所需的最低权限
    /// </summary>
    public string RequiredPermission { get; set; } = string.Empty;

    /// <summary>
    /// 排序权重
    /// </summary>
    public int SortOrder { get; set; }
}

