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
        // ── 首页 (home) ──
        new("home", "/", "首页", "回到欢迎页", "Home", 1, "home"),

        // ── 效率工具 (tools) ──
        new("ai-toolbox", "/ai-toolbox", "AI 百宝箱", "智能工具集合", "Sparkles", 10, "tools"),
        new("workflow-agent", "/workflow-agent", "工作流", "自动化流程编排", "Workflow", 20, "tools"),
        new("executive", "/executive", "团队洞察", "团队数据概览与分析", "BarChart3", 25, "tools"),

        // ── 个人空间 (personal) ──
        new("marketplace", "/marketplace", "探索市场", "发现优质配置与技能", "Store", 30, "personal"),
        new("my-assets", "/my-assets", "我的资源", "图片、文档与附件", "FolderOpen", 40, "personal"),
        // ── 以下三项仅在首页"实用工具"中展示，不在侧边栏菜单 ──
        new("web-pages", "/web-pages", "网页托管", "创建与管理网页", "Globe", 45),
        new("document-store", "/document-store", "知识库", "文档存储与知识管理", "Library", 46),
        new("emergence", "/emergence", "涌现探索", "可视化功能涌现与创意探索", "Sparkle", 47),

        // ── 系统管理 (admin) ──
        new("mds", "/mds", "模型中心", "模型、提示词与实验室", "Cpu", 50, "admin"),
        new("users", "/users", "用户权限", "用户与角色管理", "Users", 60, "admin"),
        new("settings", "/settings", "数据运维", "数据管理与系统配置", "Server", 70, "admin"),

        // ── 头像面板 (无 Group，不在侧边栏显示) ──
        new("logs", "/logs", "请求日志", null, "ScrollText", 130),

        // ── 隐藏项（已合并到其他菜单，保留权限注册） ──
        new("prompts", "/prompts", "提示词管理", null, "FileText", 200),
        new("skills", "/skills", "技能管理", null, "Zap", 210),
        new("lab", "/lab", "实验室", null, "FlaskConical", 220),
        new("automations", "/automations", "自动化", null, "Zap", 230),
        new("arena", "/arena", "AI 竞技场", null, "Swords", 240),
        new("shortcuts-agent", "/shortcuts-agent", "快捷指令", null, "Smartphone", 250),
        new("transcript-agent", "/transcript-agent", "转录工作台", null, "FileAudio", 260),
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
            // 基础功能：只需要基础访问权限
            if (menu.AppKey is "home" or "ai-toolbox" or "my-assets" or "settings" or "arena" or "shortcuts-agent" or "marketplace" or "web-pages" or "document-store" or "emergence")
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
/// <param name="Group">分组标识：tools=效率工具, personal=个人空间, admin=系统管理, null=仅头像面板</param>
public sealed record AdminMenuDef(
    string AppKey,
    string Path,
    string Label,
    string? Description,
    string Icon,
    int SortOrder,
    string? Group = null
);
