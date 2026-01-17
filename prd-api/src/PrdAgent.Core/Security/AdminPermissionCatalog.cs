namespace PrdAgent.Core.Security;

/// <summary>
/// 管理后台权限点清单（代码侧稳定定义，分配关系存储在 DB）。
/// 说明：
/// - 权限点是“合约”，需要稳定；不建议频繁改 key。
/// - 菜单/路由/接口的准入建议都绑定到这些 key 上，避免“只藏菜单不控访问”的不一致。
/// </summary>
public static class AdminPermissionCatalog
{
    public const string AdminAccess = "admin.access";
    public const string AuthzManage = "admin.authz.manage";

    public const string UsersRead = "admin.users.read";
    public const string UsersWrite = "admin.users.write";

    public const string GroupsRead = "admin.groups.read";
    public const string GroupsWrite = "admin.groups.write";

    public const string ModelsRead = "admin.models.read";
    public const string ModelsWrite = "admin.models.write";

    public const string LogsRead = "admin.logs.read";

    public const string OpenPlatformManage = "admin.open-platform.manage";

    public const string DataRead = "admin.data.read";
    public const string DataWrite = "admin.data.write";

    public const string AssetsRead = "admin.assets.read";
    public const string AssetsWrite = "admin.assets.write";

    public const string SettingsRead = "admin.settings.read";
    public const string SettingsWrite = "admin.settings.write";

    /// <summary>
    /// Agent 体验权限：用于开放 PRD Agent / 视觉创作 Agent / 文学创作 Agent 等“体验型功能”菜单与相关后台接口。
    /// </summary>
    public const string AgentUse = "admin.agent.use";

    /// <summary>
    /// 超级权限（当 admin 路由未配置映射时，用于兜底放行；同时也可用于 root 破窗全权限）。
    /// </summary>
    public const string Super = "admin.super";

    public static readonly IReadOnlyList<AdminPermissionDef> All = new List<AdminPermissionDef>
    {
        new(AdminAccess, "后台访问", "允许进入管理后台"),
        new(AuthzManage, "权限管理", "管理系统角色/用户权限"),
        new(AgentUse, "Agent 体验", "允许访问 PRD/视觉/文学 Agent 等体验功能"),

        new(UsersRead, "用户管理-读", "查看用户列表/详情"),
        new(UsersWrite, "用户管理-写", "创建/编辑/禁用/重置密码等"),

        new(GroupsRead, "群组管理-读", "查看群组与成员"),
        new(GroupsWrite, "群组管理-写", "编辑群组/成员等"),

        new(ModelsRead, "模型管理-读", "查看平台/模型/配置"),
        new(ModelsWrite, "模型管理-写", "编辑平台/模型/配置/调度等"),

        new(LogsRead, "日志-读", "查看系统/LLM/API 请求日志"),

        new(OpenPlatformManage, "开放平台", "管理开放平台 App / 调用方 / 日志"),

        new(DataRead, "数据管理-读", "查看导入导出/摘要"),
        new(DataWrite, "数据管理-写", "执行导入/清理等危险操作"),

        new(AssetsRead, "资产-读", "查看/下载资产"),
        new(AssetsWrite, "资产-写", "上传/删除资产"),

        new(SettingsRead, "设置-读", "查看系统设置"),
        new(SettingsWrite, "设置-写", "修改系统设置"),

        new(Super, "超级权限", "兜底放行：建议仅给 root/超级管理员"),
    };
}

public sealed record AdminPermissionDef(string Key, string Name, string? Description);
