using System.Reflection;
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
        "/api/v1/admin/authz/me",
        "/api/v1/admin/authz/catalog",
        "/api/v1/admin/authz/menu-catalog",
        "/api/v1/admin/notifications",
    };

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

        // 未匹配到任何标记的 Controller
        // 如果是 admin 路由，返回超级权限作为兜底
        if (path.StartsWith("/api/v1/admin", StringComparison.OrdinalIgnoreCase))
        {
            return AdminPermissionCatalog.Super;
        }

        // 非 admin 路由，不需要权限检查
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
