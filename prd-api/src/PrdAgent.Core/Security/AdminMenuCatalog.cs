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
        // 总裁面板（替代原仪表盘）
        new("executive", "/executive", "总裁面板", null, "Crown", 5),

        // 用户管理
        new("users", "/users", "用户管理", null, "Users", 20),

        // PRD 协作（群组 + PRD Agent 对话，双页签）
        new("prd-agent", "/prd-agent", "PRD 协作", null, "MessagesSquare", 30),

        // 模型管理
        new("mds", "/mds", "模型管理", null, "Cpu", 40),

        // 提示词管理
        new("prompts", "/prompts", "提示词管理", null, "FileText", 50),

        // AI 百宝箱（Agent 统一入口）
        new("ai-toolbox", "/ai-toolbox", "AI 百宝箱", null, "Sparkles", 60),

        // 日志
        new("logs", "/logs", "请求日志", null, "ScrollText", 100),

        // 系统设置（含资源管理、权限管理、数据管理页签，仅管理员可见）
        new("settings", "/settings", "系统设置", null, "Settings", 115),

        // 开放平台
        new("open-platform", "/open-platform", "开放平台", null, "Plug", 120),

        // 自动化
        new("automations", "/automations", "自动化", null, "Zap", 125),

        // 实验室
        new("lab", "/lab", "实验室", null, "FlaskConical", 140),
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
            // AI 百宝箱 / 系统设置：只需要基础访问权限
            if (menu.AppKey is "ai-toolbox" or "settings")
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
