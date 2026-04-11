using PrdAgent.Core.Models;

namespace PrdAgent.Core.Security;

/// <summary>
/// 内置系统角色默认定义（可用于初始化与"重置内置角色"）。
/// 说明：
/// - 这里是"默认值"，不应在启动时强制覆盖用户修改；覆盖应由显式"重置"操作触发。
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
                AdminPermissionCatalog.Access,
                // Agent 权限
                AdminPermissionCatalog.PrdAgentUse,
                AdminPermissionCatalog.VisualAgentUse,
                AdminPermissionCatalog.LiteraryAgentUse,
                AdminPermissionCatalog.DefectAgentUse,
                AdminPermissionCatalog.DefectAgentManage,
                AdminPermissionCatalog.VideoAgentUse,
                AdminPermissionCatalog.ArenaAgentUse,
                AdminPermissionCatalog.ReportAgentUse,
                AdminPermissionCatalog.WorkflowAgentUse,
                AdminPermissionCatalog.AiToolboxUse,
                AdminPermissionCatalog.ReviewAgentUse,
                AdminPermissionCatalog.PrReviewUse,
                // 管理权限
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
                AdminPermissionCatalog.LabRead,
                AdminPermissionCatalog.LabWrite,
                // 网页托管（基础功能，人人可用）
                AdminPermissionCatalog.WebPagesRead,
                AdminPermissionCatalog.WebPagesWrite,
            }
        ),
        new(
            Key: "viewer",
            Name: "只读",
            Permissions: new List<string>
            {
                AdminPermissionCatalog.Access,
                // Agent 权限（只读用户也可体验 Agent）
                AdminPermissionCatalog.PrdAgentUse,
                AdminPermissionCatalog.VisualAgentUse,
                AdminPermissionCatalog.LiteraryAgentUse,
                AdminPermissionCatalog.DefectAgentUse,
                AdminPermissionCatalog.VideoAgentUse,
                AdminPermissionCatalog.ArenaAgentUse,
                AdminPermissionCatalog.ReportAgentUse,
                AdminPermissionCatalog.AiToolboxUse,
                AdminPermissionCatalog.ReviewAgentUse,
                AdminPermissionCatalog.PrReviewUse,
                // 只读管理权限
                AdminPermissionCatalog.UsersRead,
                AdminPermissionCatalog.GroupsRead,
                AdminPermissionCatalog.ModelsRead,
                AdminPermissionCatalog.LogsRead,
                AdminPermissionCatalog.DataRead,
                AdminPermissionCatalog.AssetsRead,
                AdminPermissionCatalog.SettingsRead,
                AdminPermissionCatalog.LabRead,
                // 网页托管（基础功能，人人可用）
                AdminPermissionCatalog.WebPagesRead,
                AdminPermissionCatalog.WebPagesWrite,
            }
        ),
        new(
            Key: "agent_tester",
            Name: "Agent 体验者",
            Permissions: new List<string>
            {
                AdminPermissionCatalog.Access,
                // 所有 Agent 使用权限
                AdminPermissionCatalog.PrdAgentUse,
                AdminPermissionCatalog.VisualAgentUse,
                AdminPermissionCatalog.LiteraryAgentUse,
                AdminPermissionCatalog.DefectAgentUse,
                AdminPermissionCatalog.VideoAgentUse,
                AdminPermissionCatalog.ArenaAgentUse,
                AdminPermissionCatalog.ReportAgentUse,
                AdminPermissionCatalog.WorkflowAgentUse,
                AdminPermissionCatalog.AiToolboxUse,
                AdminPermissionCatalog.ReviewAgentUse,
                AdminPermissionCatalog.PrReviewUse,
                // PRD Agent 读取提示词需要 settings.read，但不应默认展示"提示词管理"（前端已改为 prompts.write 才可见）
                AdminPermissionCatalog.SettingsRead,
                // 网页托管（基础功能，人人可用）
                AdminPermissionCatalog.WebPagesRead,
                AdminPermissionCatalog.WebPagesWrite,
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
