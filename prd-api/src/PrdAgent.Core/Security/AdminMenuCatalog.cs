using PrdAgent.Core.Interfaces;

namespace PrdAgent.Core.Security;

/// <summary>
/// 管理后台菜单目录（代码侧稳定定义）。
/// 说明：
/// - 每个菜单项绑定一个 appKey，对应后端 Controller 路由前缀
/// - 前端通过 API 获取此目录，自动生成导航
/// - 菜单可见性由 GetMenusForUser 方法根据用户权限和 Controller 扫描结果动态计算
/// </summary>
public static class AdminMenuCatalog
{
    /// <summary>
    /// 所有菜单定义（静态列表，不含权限过滤逻辑）
    /// </summary>
    public static readonly IReadOnlyList<AdminMenuDef> All = new List<AdminMenuDef>
    {
        // 总裁面板
        new("executive", "/executive", "总裁面板", "团队工作与 AI 使用全景", "Crown", 5),

        // 仪表盘：所有登录用户可见（只需 admin.access）
        new("dashboard", "/", "仪表盘", "LLM 可观测性与数据概览", "LayoutDashboard", 10),

        // 用户与群组管理
        new("users", "/users", "用户管理", "账号、角色与权限管理", "Users", 20),
        new("groups", "/groups", "群组管理", "协作群组与成员管理", "Users2", 30),

        // 模型管理
        new("mds", "/mds", "模型管理", "平台、模型与配置管理", "Cpu", 40),

        // 提示词管理
        new("prompts", "/prompts", "提示词管理", "PRD 问答提示词配置", "FileText", 50),

        // Agent 体验类菜单
        new("prd-agent", "/prd-agent", "PRD Agent", "PRD 智能解读与问答", "MessagesSquare", 60),
        new("defect-agent", "/defect-agent", "缺陷管理 Agent", "缺陷提交与跟踪", "Bug", 65),
        new("visual-agent", "/visual-agent", "视觉创作 Agent", "高级视觉创作工作区", "Wand2", 70),
        new("literary-agent", "/literary-agent", "文学创作 Agent", "文章配图智能生成", "PenLine", 80),
        new("ai-toolbox", "/ai-toolbox", "AI 百宝箱", "多 Agent 协作智能助手", "Sparkles", 85),

        // 资源管理
        new("assets", "/assets", "资源管理", "Desktop 资源与品牌配置", "Image", 90),

        // 日志
        new("logs", "/logs", "请求日志", "LLM 请求与系统日志", "ScrollText", 100),

        // 数据管理
        new("data", "/data", "数据管理", "数据概览、清理与迁移", "Database", 110),

        // 系统设置
        new("settings", "/settings", "系统设置", "系统初始化与配置", "Settings", 115),

        // 开放平台
        new("open-platform", "/open-platform", "开放平台", "API 应用与调用日志", "Plug", 120),

        // 自动化
        new("automations", "/automations", "自动化", "事件驱动的自动化规则引擎", "Zap", 125),

        // 权限管理
        new("authz", "/authz", "权限管理", "系统角色与用户权限", "UserCog", 130),

        // 实验室
        new("lab", "/lab", "实验室", "模型测试与实验功能", "FlaskConical", 140),
    };

    /// <summary>
    /// 根据扫描结果和用户权限生成用户可见的菜单列表。
    /// 逻辑：用户拥有某个 appKey 下任意 Controller 的权限，就能看到对应菜单。
    /// </summary>
    /// <param name="scanner">Controller 扫描器</param>
    /// <param name="userPermissions">用户有效权限列表</param>
    /// <returns>用户可见的菜单列表（已排序）</returns>
    public static IReadOnlyList<AdminMenuDef> GetMenusForUser(
        IAdminControllerScanner scanner,
        IReadOnlyList<string> userPermissions)
    {
        var appKeyMap = scanner.GetAppKeyMap();
        var permSet = new HashSet<string>(userPermissions, StringComparer.Ordinal);
        var result = new List<AdminMenuDef>();

        foreach (var menu in All)
        {
            // 系统设置：只需要基础访问权限
            if (menu.AppKey is "settings")
            {
                if (permSet.Contains(AdminPermissionCatalog.Access))
                {
                    result.Add(menu);
                }
                continue;
            }

            // 总裁面板：需要独立权限
            if (menu.AppKey is "executive")
            {
                if (permSet.Contains(AdminPermissionCatalog.ExecutiveRead) ||
                    permSet.Contains(AdminPermissionCatalog.Super))
                {
                    result.Add(menu);
                }
                continue;
            }

            // 仪表盘：需要 Access + 至少一个数据查看权限（Agent 体验者看不到仪表盘）
            if (menu.AppKey is "dashboard")
            {
                if (permSet.Contains(AdminPermissionCatalog.Access) &&
                    (permSet.Contains(AdminPermissionCatalog.ModelsRead) ||
                     permSet.Contains(AdminPermissionCatalog.LogsRead) ||
                     permSet.Contains(AdminPermissionCatalog.DataRead) ||
                     permSet.Contains(AdminPermissionCatalog.UsersRead) ||
                     permSet.Contains(AdminPermissionCatalog.GroupsRead) ||
                     permSet.Contains(AdminPermissionCatalog.Super)))
                {
                    result.Add(menu);
                }
                continue;
            }

            // 查找该 appKey 下的所有 Controller
            if (!appKeyMap.TryGetValue(menu.AppKey, out var controllers) || controllers.Count == 0)
            {
                continue;
            }

            // 用户是否拥有该 appKey 下任意 Controller 的读或写权限？
            var hasAnyPermission = controllers.Any(c =>
                permSet.Contains(c.ReadPermission) ||
                permSet.Contains(c.WritePermission));

            // 或者用户有超级权限
            if (hasAnyPermission || permSet.Contains(AdminPermissionCatalog.Super))
            {
                result.Add(menu);
            }
        }

        return result.OrderBy(m => m.SortOrder).ToList();
    }
}

/// <summary>
/// 菜单定义（不再包含 RequiredPermission，权限由 Controller 扫描动态确定）
/// </summary>
/// <param name="AppKey">应用标识，对应后端 Controller 路由前缀</param>
/// <param name="Path">前端路由路径</param>
/// <param name="Label">菜单显示名称</param>
/// <param name="Description">菜单描述</param>
/// <param name="Icon">图标名称（Lucide icon name）</param>
/// <param name="SortOrder">排序权重（越小越靠前）</param>
public sealed record AdminMenuDef(
    string AppKey,
    string Path,
    string Label,
    string? Description,
    string Icon,
    int SortOrder
);
