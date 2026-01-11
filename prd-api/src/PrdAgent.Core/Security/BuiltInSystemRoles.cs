using PrdAgent.Core.Models;

namespace PrdAgent.Core.Security;

/// <summary>
/// 内置系统角色默认定义（可用于初始化与“重置内置角色”）。
/// 说明：
/// - 这里是“默认值”，不应在启动时强制覆盖用户修改；覆盖应由显式“重置”操作触发。
/// </summary>
public static class BuiltInSystemRoles
{
    public static IReadOnlyList<BuiltInSystemRoleDef> Definitions => new List<BuiltInSystemRoleDef>
    {
        new(
            Key: "admin",
            Name: "管理员",
            Permissions: AdminPermissionCatalog.All.Select(x => x.Key).ToList()
        ),
        new(
            Key: "operator",
            Name: "运营/运维",
            Permissions: new List<string>
            {
                AdminPermissionCatalog.AdminAccess,
                AdminPermissionCatalog.AgentUse,
                AdminPermissionCatalog.ModelsRead,
                AdminPermissionCatalog.ModelsWrite,
                AdminPermissionCatalog.GroupsRead,
                AdminPermissionCatalog.GroupsWrite,
                AdminPermissionCatalog.LogsRead,
                AdminPermissionCatalog.DataRead,
                AdminPermissionCatalog.DataWrite,
                AdminPermissionCatalog.AssetsRead,
                AdminPermissionCatalog.AssetsWrite,
                AdminPermissionCatalog.OpenPlatformManage,
                AdminPermissionCatalog.SettingsRead,
            }
        ),
        new(
            Key: "viewer",
            Name: "只读",
            Permissions: new List<string>
            {
                AdminPermissionCatalog.AdminAccess,
                AdminPermissionCatalog.AgentUse,
                AdminPermissionCatalog.UsersRead,
                AdminPermissionCatalog.GroupsRead,
                AdminPermissionCatalog.ModelsRead,
                AdminPermissionCatalog.LogsRead,
                AdminPermissionCatalog.DataRead,
                AdminPermissionCatalog.AssetsRead,
                AdminPermissionCatalog.SettingsRead,
            }
        ),
        new(
            Key: "agent_tester",
            Name: "Agent 体验者",
            Permissions: new List<string>
            {
                AdminPermissionCatalog.AdminAccess,
                AdminPermissionCatalog.AgentUse,
                // PRD Agent 读取提示词需要 settings.read，但不应默认展示“提示词管理”（前端已改为 settings.write 才可见）
                AdminPermissionCatalog.SettingsRead,
            }
        ),
        new(
            Key: "none",
            Name: "无权限",
            Permissions: new List<string>()
        ),
    };
}

public sealed record BuiltInSystemRoleDef(string Key, string Name, List<string> Permissions);

