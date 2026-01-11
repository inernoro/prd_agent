using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Text.Json;
using PrdAgent.Api.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 管理后台权限中间件：把“接口路径 + HTTP 方法”映射到 permission key，再用有效权限集合做准入。
/// 目标：尽量少改 Controller（避免到处加 attribute），但能实现“控菜单 + 控接口一致”。\n/// </summary>
public sealed class AdminPermissionMiddleware
{
    private readonly RequestDelegate _next;
    private readonly JsonSerializerOptions _jsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public AdminPermissionMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    private static bool IsRoot(HttpContext ctx)
        => string.Equals(ctx.User?.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);

    private static bool IsReadMethod(string method)
        => HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method);

    private static string? GetRequiredPermission(string path, string method)
    {
        // 自己的权限（用于前端加载菜单/路由）：只要求能进入后台
        if (path.StartsWith("/api/v1/admin/authz/me", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/authz/catalog", StringComparison.OrdinalIgnoreCase))
        {
            return AdminPermissionCatalog.AdminAccess;
        }

        // 权限管理本身（最敏感）
        if (path.StartsWith("/api/v1/admin/authz", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/system-roles", StringComparison.OrdinalIgnoreCase) ||
            path.Contains("/api/v1/admin/users/", StringComparison.OrdinalIgnoreCase) && path.EndsWith("/authz", StringComparison.OrdinalIgnoreCase))
        {
            return AdminPermissionCatalog.AuthzManage;
        }

        // 用户管理
        if (path.StartsWith("/api/v1/admin/users", StringComparison.OrdinalIgnoreCase))
            return IsReadMethod(method) ? AdminPermissionCatalog.UsersRead : AdminPermissionCatalog.UsersWrite;

        // 群组管理
        if (path.StartsWith("/api/v1/admin/groups", StringComparison.OrdinalIgnoreCase))
            return IsReadMethod(method) ? AdminPermissionCatalog.GroupsRead : AdminPermissionCatalog.GroupsWrite;

        // 模型管理（平台/模型/配置/分组/调度/模型实验等）
        if (path.StartsWith("/api/v1/admin/models", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/model-groups", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/llm-configs", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/scheduler-config", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/model-test", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/model-lab", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/platforms", StringComparison.OrdinalIgnoreCase))
        {
            return IsReadMethod(method) ? AdminPermissionCatalog.ModelsRead : AdminPermissionCatalog.ModelsWrite;
        }

        // 日志
        if (path.StartsWith("/api/v1/admin/llm-logs", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/api-logs", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/stats", StringComparison.OrdinalIgnoreCase))
        {
            return AdminPermissionCatalog.LogsRead;
        }

        // 开放平台
        if (path.StartsWith("/api/v1/admin/open-platform", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/app-callers", StringComparison.OrdinalIgnoreCase))
        {
            return AdminPermissionCatalog.OpenPlatformManage;
        }

        // 数据/导入导出
        if (path.StartsWith("/api/v1/admin/data", StringComparison.OrdinalIgnoreCase))
            return IsReadMethod(method) ? AdminPermissionCatalog.DataRead : AdminPermissionCatalog.DataWrite;

        // 资产（桌面资源/头像/通用 assets 等）
        if (path.StartsWith("/api/v1/admin/assets", StringComparison.OrdinalIgnoreCase))
            return IsReadMethod(method) ? AdminPermissionCatalog.AssetsRead : AdminPermissionCatalog.AssetsWrite;

        // 设置
        if (path.StartsWith("/api/v1/admin/settings", StringComparison.OrdinalIgnoreCase))
            return IsReadMethod(method) ? AdminPermissionCatalog.SettingsRead : AdminPermissionCatalog.SettingsWrite;

        // 提示词（后台配置）
        if (path.StartsWith("/api/v1/admin/prompts", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/system-prompts", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/prompt-overrides", StringComparison.OrdinalIgnoreCase))
        {
            return IsReadMethod(method) ? AdminPermissionCatalog.SettingsRead : AdminPermissionCatalog.SettingsWrite;
        }

        // Agent 体验相关（视觉/文学/生图等）：单独权限点，避免被 admin.super 兜底误伤
        if (path.StartsWith("/api/v1/admin/image-master", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/image-gen", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/literary-prompts", StringComparison.OrdinalIgnoreCase))
        {
            return AdminPermissionCatalog.AgentUse;
        }

        // 文档（后台查看/导出）
        if (path.StartsWith("/api/v1/admin/documents", StringComparison.OrdinalIgnoreCase))
        {
            return IsReadMethod(method) ? AdminPermissionCatalog.DataRead : AdminPermissionCatalog.DataWrite;
        }

        // 实验室（后台实验/测试）
        if (path.StartsWith("/api/v1/admin/lab", StringComparison.OrdinalIgnoreCase))
        {
            return IsReadMethod(method) ? AdminPermissionCatalog.ModelsRead : AdminPermissionCatalog.ModelsWrite;
        }

        // init/运维：默认当做“高风险写操作”
        if (path.StartsWith("/api/v1/admin/init", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/api/v1/admin/upload-artifacts", StringComparison.OrdinalIgnoreCase))
        {
            return AdminPermissionCatalog.SettingsWrite;
        }

        // 未覆盖到的 admin 路由：仅允许 admin.super（避免遗漏映射导致误开放）
        if (path.StartsWith("/api/v1/admin/", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(path, "/api/v1/admin", StringComparison.OrdinalIgnoreCase))
        {
            return AdminPermissionCatalog.Super;
        }

        return null;
    }

    public async Task Invoke(HttpContext context, IAdminPermissionService permissionService)
    {
        var path = context.Request.Path.Value ?? string.Empty;
        var required = GetRequiredPermission(path, context.Request.Method);
        if (required == null)
        {
            await _next(context);
            return;
        }

        // 管理后台默认还要求已登录（Controller 侧也有 [Authorize]，这里做个保险兜底）
        if (context.User?.Identity?.IsAuthenticated != true)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            context.Response.ContentType = "application/json; charset=utf-8";
            var payload = ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权");
            await context.Response.WriteAsync(JsonSerializer.Serialize(payload, _jsonOptions));
            return;
        }

        var userId = context.User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? string.Empty;
        var isRoot = IsRoot(context);

        var perms = await permissionService.GetEffectivePermissionsAsync(userId, isRoot);
        var has = perms.Contains(AdminPermissionCatalog.Super) ||
                  perms.Contains(required);

        // 所有 admin.* 权限都必须先具备 admin.access（除了 root/super）
        if (!isRoot &&
            !perms.Contains(AdminPermissionCatalog.Super) &&
            !perms.Contains(AdminPermissionCatalog.AdminAccess))
        {
            has = false;
        }

        if (!has)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            context.Response.ContentType = "application/json; charset=utf-8";
            var payload = ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限");
            await context.Response.WriteAsync(JsonSerializer.Serialize(payload, _jsonOptions));
            return;
        }

        await _next(context);
    }
}

