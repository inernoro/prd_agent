namespace PrdAgent.Core.Security;

/// <summary>
/// 管理后台菜单目录（代码侧稳定定义）。
/// 说明：
/// - 每个菜单项绑定一个 appKey，对应后端 Controller 路由前缀
/// - requiredPermission 是进入该菜单的最低权限要求
/// - 前端通过 API 获取此目录，自动生成导航并进行权限过滤
/// </summary>
public static class AdminMenuCatalog
{
    public static readonly IReadOnlyList<AdminMenuDef> All = new List<AdminMenuDef>
    {
        // 仪表盘：所有登录用户可见（只需 admin.access）
        new("dashboard", "/", "仪表盘", "LLM 可观测性与数据概览", "LayoutDashboard", AdminPermissionCatalog.AdminAccess, 10),

        // 用户与群组管理
        new("admin-users", "/users", "用户管理", "账号、角色与权限管理", "Users", AdminPermissionCatalog.UsersRead, 20),
        new("admin-groups", "/groups", "群组管理", "协作群组与成员管理", "Users2", AdminPermissionCatalog.GroupsRead, 30),

        // 模型管理
        new("admin-models", "/model-manage", "模型管理", "平台、模型与配置管理", "Cpu", AdminPermissionCatalog.ModelsRead, 40),

        // 提示词管理
        new("admin-prompts", "/prompts", "提示词管理", "PRD 问答提示词配置", "FileText", AdminPermissionCatalog.SettingsWrite, 50),

        // Agent 体验类菜单
        new("prd-agent", "/ai-chat", "PRD Agent", "PRD 智能解读与问答", "MessagesSquare", AdminPermissionCatalog.AgentUse, 60),
        new("visual-agent", "/visual-agent-fullscreen", "视觉创作 Agent", "高级视觉创作工作区", "Wand2", AdminPermissionCatalog.AgentUse, 70),
        new("literary-agent", "/literary-agent", "文学创作 Agent", "文章配图智能生成", "PenLine", AdminPermissionCatalog.AgentUse, 80),

        // 资源管理
        new("admin-assets", "/assets", "资源管理", "Desktop 资源与品牌配置", "Image", AdminPermissionCatalog.AssetsRead, 90),

        // 日志
        new("admin-logs", "/llm-logs", "请求日志", "LLM 请求与系统日志", "ScrollText", AdminPermissionCatalog.LogsRead, 100),

        // 数据管理
        new("admin-data", "/data", "数据管理", "数据概览、清理与迁移", "Database", AdminPermissionCatalog.DataRead, 110),

        // 开放平台
        new("admin-open-platform", "/open-platform", "开放平台", "API 应用与调用日志", "Plug", AdminPermissionCatalog.OpenPlatformManage, 120),

        // 权限管理
        new("admin-authz", "/authz", "权限管理", "系统角色与用户权限", "UserCog", AdminPermissionCatalog.AuthzManage, 130),

        // 实验室
        new("admin-lab", "/lab", "实验室", "模型测试与实验功能", "FlaskConical", AdminPermissionCatalog.ModelsRead, 140),
    };
}

/// <summary>
/// 菜单定义
/// </summary>
/// <param name="AppKey">应用标识，对应后端 Controller 路由前缀</param>
/// <param name="Path">前端路由路径</param>
/// <param name="Label">菜单显示名称</param>
/// <param name="Description">菜单描述</param>
/// <param name="Icon">图标名称（Lucide icon name）</param>
/// <param name="RequiredPermission">进入该菜单所需的最低权限</param>
/// <param name="SortOrder">排序权重（越小越靠前）</param>
public sealed record AdminMenuDef(
    string AppKey,
    string Path,
    string Label,
    string? Description,
    string Icon,
    string RequiredPermission,
    int SortOrder
);
