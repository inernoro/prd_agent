using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PrdAgent.Api.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 管理后台权限中间件：基于反射扫描结果自动映射"接口路径 + HTTP 方法"到 permission key。
/// 通过 IAdminControllerScanner 在启动时扫描所有标记了 [AdminController] 属性的 Controller，
/// 然后在运行时根据请求路径查找对应的权限要求。
/// </summary>
public sealed class AdminPermissionMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<AdminPermissionMiddleware> _logger;
    private readonly IAdminControllerScanner _scanner;
    private readonly JsonSerializerOptions _jsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public AdminPermissionMiddleware(
        RequestDelegate next,
        ILogger<AdminPermissionMiddleware> logger,
        IAdminControllerScanner scanner)
    {
        _next = next;
        _logger = logger;
        _scanner = scanner;
    }

    /// <summary>
    /// 判断是否具有超级权限（root 账户或 AI 超级访问模式）
    /// </summary>
    private static bool IsRoot(HttpContext ctx)
    {
        // 方式 1：root 破窗账户
        if (string.Equals(ctx.User?.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal))
            return true;

        // 方式 2：AI 超级访问密钥
        if (string.Equals(ctx.User?.FindFirst(Authentication.AiAccessKeyAuthenticationHandler.ClaimTypeIsAiSuperAccess)?.Value, "1", StringComparison.Ordinal))
            return true;

        return false;
    }

    /// <summary>
    /// AgentApiKey scope 授权：scope "a:b"（冒号）满足 admin 权限 "a.b"（点分）。
    /// 让持 document-store:write scope 的最小权限 M2M Key 能写文档空间，
    /// 无需 admin 账户权限位、无需 AI 超级密钥。精确等值匹配，不跨资源泄漏
    /// （document-store:write 只满足 document-store.write，不满足别的权限）。
    /// </summary>
    private static bool HasScopeGrant(HttpContext ctx, string requiredPermission)
    {
        var scopes = ctx.User?.FindAll("scope");
        if (scopes == null) return false;
        foreach (var c in scopes)
        {
            if (string.Equals(c.Value.Replace(':', '.'), requiredPermission, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }


    public async Task Invoke(HttpContext context, IAdminPermissionService permissionService)
    {
        var path = context.Request.Path.Value ?? string.Empty;
        var method = context.Request.Method;

        // 使用扫描器获取所需权限
        var required = _scanner.GetRequiredPermission(path, method);

        if (required == null)
        {
            await _next(context);
            return;
        }

        // 管理后台默认还要求已登录（Controller 侧也有 [Authorize]，这里做个保险兜底）
        if (context.User?.Identity?.IsAuthenticated != true)
        {
            var clientIp = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
            var authHeader = context.Request.Headers.Authorization.FirstOrDefault();
            var hasToken = !string.IsNullOrWhiteSpace(authHeader);
            _logger.LogWarning("[401] 管理后台未登录访问 - Path: {Path}, Method: {Method}, IP: {IP}, HasToken: {HasToken}, RequiredPermission: {Permission}",
                path, method, clientIp, hasToken, required);

            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            context.Response.ContentType = "application/json; charset=utf-8";
            var payload = ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权");
            await context.Response.WriteAsync(JsonSerializer.Serialize(payload, _jsonOptions));
            return;
        }

        // AgentApiKey 走"纯 scope"授权，保证最小权限：M2M Key 命中匹配 scope 才放行，
        // 且【绝不】继承 owner 的 admin 权限/root（否则 root 名下的 scoped key 等于全权，最小权限失效）。
        // scope "a:b"（冒号）精确满足 admin 权限 "a.b"（点分），不跨资源泄漏。
        var isAgentKey = string.Equals(context.User.FindFirst("authType")?.Value, "agent-apikey", StringComparison.Ordinal);
        if (isAgentKey)
        {
            if (HasScopeGrant(context, required))
            {
                await _next(context);
                return;
            }
            var ip = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
            _logger.LogWarning("[403] AgentApiKey scope 不足 - Path: {Path}, Method: {Method}, IP: {IP}, Required: {Required}",
                path, method, ip, required);
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            context.Response.ContentType = "application/json; charset=utf-8";
            var denied = ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED,
                $"此接口要求 scope: {required.Replace('.', ':')}。当前 AgentApiKey 未授权该范围。");
            await context.Response.WriteAsync(JsonSerializer.Serialize(denied, _jsonOptions));
            return;
        }

        var userId = context.User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? string.Empty;
        var isRoot = IsRoot(context);

        var perms = await permissionService.GetEffectivePermissionsAsync(userId, isRoot);
        var has = perms.Contains(AdminPermissionCatalog.Super) ||
                  perms.Contains(required);

        // 所有权限都必须先具备 access 权限（除了 root/super）
        if (!isRoot &&
            !perms.Contains(AdminPermissionCatalog.Super) &&
            !perms.Contains(AdminPermissionCatalog.Access))
        {
            has = false;
        }

        // 将有效权限注入 User claims，供下游 Controller 中的 HasPermission() 使用
        var identity = context.User.Identity as System.Security.Claims.ClaimsIdentity;
        if (identity != null)
        {
            foreach (var p in perms)
            {
                identity.AddClaim(new System.Security.Claims.Claim("permissions", p));
            }
        }

        if (!has)
        {
            var clientIp = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
            _logger.LogWarning("[403] 管理后台权限不足 - Path: {Path}, Method: {Method}, IP: {IP}, UserId: {UserId}, RequiredPermission: {Required}, UserPermissions: [{Permissions}]",
                path, method, clientIp, userId, required, string.Join(", ", perms));

            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            context.Response.ContentType = "application/json; charset=utf-8";
            var payload = ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限");
            await context.Response.WriteAsync(JsonSerializer.Serialize(payload, _jsonOptions));
            return;
        }

        await _next(context);
    }
}
