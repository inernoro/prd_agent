using System.Reflection;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// Admin Controller 反射扫描服务实现
/// 在应用启动时扫描所有标记了 [AdminController] 属性的 Controller，
/// 生成 RoutePrefix → Permission 的映射表
/// </summary>
public sealed class AdminControllerScanner : IAdminControllerScanner
{
    private readonly List<AdminControllerMeta> _controllers;
    private readonly Dictionary<string, List<AdminControllerMeta>> _routePrefixMap;
    private readonly Dictionary<string, List<AdminControllerMeta>> _appKeyMap;
    private readonly ILogger<AdminControllerScanner> _logger;

    // 公开路由（无需额外权限检查）
    private static readonly HashSet<string> PublicRoutes = new(StringComparer.OrdinalIgnoreCase)
    {
        "/api/authz/me",
        "/api/authz/catalog",
        "/api/authz/menu-catalog",
        "/api/dashboard/notifications",
        "/api/web-pages/shares/view/",
        // 评论删除：作者本人/站点 owner 可删（DeleteCommentAsync 内做 author/owner 校验）。
        // 经分享页发表评论的普通登录用户没有 WebPagesWrite 权限，若不豁免会被 AdminPermissionMiddleware
        // 提前拦成 403（Codex P2）。这里只豁免「权限检查」，[Authorize] 仍要求登录，故仍是登录态 + 业务层鉴权。
        "/api/web-pages/comments/",
        // 知识库公开端点（智识殿堂浏览/详情/分享）
        "/api/document-store/public/",
    };

    // 站点维度评论相关路由（siteId 在路径中段，无法用 PublicRoutes 的 StartsWith 前缀命中）：
    //   - /api/web-pages/{siteId}/comments          列表(GET) + 发表(POST)
    //   - /api/web-pages/{siteId}/comments-enabled  评论开关(PATCH)
    // 这三条都在 service 层自行鉴权，不依赖全局 WebPagesWrite 管理权限：
    //   - ListCommentsBySiteAsync/AddCommentBySiteAsync 经 GetByIdAsync 校验（owner + 团队成员，含 viewer 可读/评）
    //   - SetCommentsEnabledAsync 显式只放行 owner/editor（其余返回 null → 404）
    // 若仍套用 AdminPermissionMiddleware 的 WebPagesWrite 闸门，团队 viewer 发表评论 / 团队 editor 改开关
    // 会在 service 鉴权前被中间件提前拦成 403（Codex P2，两轮）。这里只豁免「管理权限检查」，
    // [Authorize] 仍要求登录，业务层 owner/editor/成员鉴权仍在，故是登录态 + 业务层鉴权。
    private static readonly Regex SiteCommentRoute = new(
        @"^/api/web-pages/[^/]+/comments(-enabled)?/?$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // 知识库跨环境同步的「令牌端点」：被对端环境用 X-Sync-Token（非登录 JWT）调用，
    // storeId 在路径中段，前缀匹配命中不了。这三条在 DocumentStoreSyncController 内做令牌鉴权
    // （ResolveTokenStoreAsync 校验 store.SyncToken），故须从管理权限闸门豁免，否则会被
    // AdminPermissionMiddleware 提前拦成 401/403，跨环境探测/拉取/推送全部失败（Codex P1）。
    private static readonly Regex SyncTokenRoute = new(
        @"^/api/document-store/stores/[^/]+/sync/(signature|bundle|apply)/?$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public AdminControllerScanner(ILogger<AdminControllerScanner> logger, Assembly? controllerAssembly = null)
    {
        _logger = logger;
        _controllers = ScanControllers(controllerAssembly);

        // 构建 RoutePrefix → List<Meta> 映射（同一路由前缀可能有多个 Controller）
        // 按路径长度降序排列以支持最长匹配
        _routePrefixMap = _controllers
            .GroupBy(c => c.RoutePrefix, StringComparer.OrdinalIgnoreCase)
            .OrderByDescending(g => g.Key.Length)
            .ToDictionary(
                g => g.Key,
                g => g.ToList(),
                StringComparer.OrdinalIgnoreCase);

        // 构建 AppKey → List<Meta> 映射
        _appKeyMap = _controllers
            .GroupBy(c => c.AppKey, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                g => g.Key,
                g => g.ToList(),
                StringComparer.OrdinalIgnoreCase);

        _logger.LogInformation(
            "AdminControllerScanner: 扫描完成，找到 {Count} 个标记了 [AdminController] 的 Controller，覆盖 {AppKeyCount} 个 AppKey，{RoutePrefixCount} 个路由前缀",
            _controllers.Count,
            _appKeyMap.Count,
            _routePrefixMap.Count);

        // 打印扫描详情（Debug 级别）
        foreach (var meta in _controllers)
        {
            _logger.LogDebug(
                "  - {ControllerName}: AppKey={AppKey}, RoutePrefix={RoutePrefix}, Read={ReadPerm}, Write={WritePerm}",
                meta.ControllerType.Name,
                meta.AppKey,
                meta.RoutePrefix,
                meta.ReadPermission,
                meta.WritePermission);
        }
    }

    private List<AdminControllerMeta> ScanControllers(Assembly? assembly)
    {
        // 如果没有指定程序集，则扫描入口程序集（通常是 PrdAgent.Api）
        assembly ??= Assembly.GetEntryAssembly();
        if (assembly == null)
        {
            _logger.LogWarning("AdminControllerScanner: 无法获取入口程序集，跳过扫描");
            return new List<AdminControllerMeta>();
        }

        var result = new List<AdminControllerMeta>();

        foreach (var type in assembly.GetTypes())
        {
            // 跳过非类、抽象类
            if (!type.IsClass || type.IsAbstract) continue;

            // 跳过非 Controller
            if (!typeof(ControllerBase).IsAssignableFrom(type)) continue;

            // 检查是否有 [AdminController] 属性
            var adminAttr = type.GetCustomAttribute<AdminControllerAttribute>();
            if (adminAttr == null) continue;

            // 获取 [Route] 属性
            var routeAttr = type.GetCustomAttribute<RouteAttribute>();
            var routeTemplate = routeAttr?.Template ?? string.Empty;

            // 规范化路由前缀（确保以 / 开头）
            var routePrefix = "/" + routeTemplate.TrimStart('/');

            result.Add(new AdminControllerMeta
            {
                RoutePrefix = routePrefix,
                AppKey = adminAttr.AppKey,
                ReadPermission = adminAttr.ReadPermission,
                WritePermission = adminAttr.WritePermission ?? adminAttr.ReadPermission,
                ControllerType = type,
            });
        }

        return result;
    }

    public IReadOnlyList<AdminControllerMeta> GetAllControllers() => _controllers;

    public IReadOnlyDictionary<string, AdminControllerMeta> GetRoutePrefixMap()
    {
        // 为兼容接口，返回每个路由前缀的第一个 Controller
        // 对于权限检查，使用 GetRequiredPermission 方法（会考虑所有同前缀 Controller）
        return _routePrefixMap.ToDictionary(
            kvp => kvp.Key,
            kvp => kvp.Value.First(),
            StringComparer.OrdinalIgnoreCase);
    }

    public IReadOnlyDictionary<string, List<AdminControllerMeta>> GetAppKeyMap() => _appKeyMap;

    public string? GetRequiredPermission(string path, string method)
    {
        // 公开路由（无需额外权限）
        if (IsPublicRoute(path))
        {
            return null;
        }

        // 在扫描结果中查找匹配的 Controller（最长前缀匹配）
        var matchedMetas = FindMatchingControllers(path);

        if (matchedMetas != null && matchedMetas.Count > 0)
        {
            // 同一路由前缀下可能有多个 Controller，取第一个的权限
            // （假设同一路由前缀下的 Controller 权限相同或兼容）
            var meta = matchedMetas.First();
            return IsReadMethod(method) ? meta.ReadPermission : meta.WritePermission;
        }

        // 未匹配到任何标记的 Controller，不需要权限检查
        return null;
    }

    private bool IsPublicRoute(string path)
    {
        foreach (var publicRoute in PublicRoutes)
        {
            if (path.StartsWith(publicRoute, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        // 站点维度评论列表/发表（siteId 在路径中段，前缀匹配命中不了）
        if (SiteCommentRoute.IsMatch(path))
        {
            return true;
        }
        // 知识库跨环境同步令牌端点（storeId 在路径中段，令牌鉴权在控制器内）
        if (SyncTokenRoute.IsMatch(path))
        {
            return true;
        }
        return false;
    }

    private List<AdminControllerMeta>? FindMatchingControllers(string path)
    {
        // _routePrefixMap 已按路径长度降序排列，第一个匹配的就是最长匹配
        foreach (var kvp in _routePrefixMap)
        {
            if (path.StartsWith(kvp.Key, StringComparison.OrdinalIgnoreCase))
            {
                return kvp.Value;
            }
        }
        return null;
    }

    private static bool IsReadMethod(string method)
    {
        return HttpMethods.IsGet(method) ||
               HttpMethods.IsHead(method) ||
               HttpMethods.IsOptions(method);
    }
}
