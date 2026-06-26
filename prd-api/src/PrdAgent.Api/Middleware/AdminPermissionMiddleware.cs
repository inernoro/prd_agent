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
    private const string DefectAgentShareScope = "defect-agent:share";
    private const string DefectAgentSharePathPrefix = "/api/defect-agent/share/view/";

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
    /// 无需 admin 账户权限位、无需 AI 超级密钥。精确等值匹配，不跨资源泄漏。
    /// 约定：写蕴含读 —— "{res}:write" 同时满足 "{res}.read"（写入流程通常要先读，
    /// 避免推荐的 write key 在 GET 上 403；仍不跨资源）。
    /// </summary>
    private static bool HasScopeGrant(HttpContext ctx, string requiredPermission)
    {
        var scopes = ctx.User?.FindAll("scope");
        if (scopes == null) return false;
        foreach (var c in scopes)
        {
            var perm = c.Value.Replace(':', '.');
            if (string.Equals(perm, requiredPermission, StringComparison.OrdinalIgnoreCase))
                return true;
            // 写蕴含读：{res}.write 满足 {res}.read
            if (perm.EndsWith(".write", StringComparison.OrdinalIgnoreCase)
                && requiredPermission.EndsWith(".read", StringComparison.OrdinalIgnoreCase)
                && string.Equals(perm[..^6], requiredPermission[..^5], StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    internal static bool HasDefectShareScopeGrant(
        IEnumerable<string> scopes,
        string requiredPermission,
        string path,
        string method)
    {
        if (!string.Equals(requiredPermission, AdminPermissionCatalog.DefectAgentUse, StringComparison.OrdinalIgnoreCase))
            return false;

        if (!scopes.Contains(DefectAgentShareScope, StringComparer.OrdinalIgnoreCase))
            return false;

        if (!path.StartsWith(DefectAgentSharePathPrefix, StringComparison.OrdinalIgnoreCase))
            return false;

        var suffix = path[DefectAgentSharePathPrefix.Length..].Trim('/');
        if (string.IsNullOrWhiteSpace(suffix))
            return false;

        var parts = suffix.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (HttpMethods.IsGet(method))
            return parts.Length == 1;

        if (!HttpMethods.IsPost(method) || parts.Length != 2)
            return false;

        return string.Equals(parts[1], "comments", StringComparison.OrdinalIgnoreCase)
               || string.Equals(parts[1], "report", StringComparison.OrdinalIgnoreCase)
               || string.Equals(parts[1], "fix-status", StringComparison.OrdinalIgnoreCase);
    }

    private static bool HasDefectShareScopeGrant(HttpContext ctx, string requiredPermission, string path, string method)
    {
        var scopes = ctx.User?.FindAll("scope").Select(c => c.Value);
        return scopes != null && HasDefectShareScopeGrant(scopes, requiredPermission, path, method);
    }

    private static void InjectBoundUserId(HttpContext context)
    {
        var boundUserId = context.User.FindFirst("boundUserId")?.Value;
        if (!string.IsNullOrEmpty(boundUserId)
            && context.User.Identity is System.Security.Claims.ClaimsIdentity idAgent
            && idAgent.FindFirst(JwtRegisteredClaimNames.Sub) == null)
        {
            idAgent.AddClaim(new System.Security.Claims.Claim(JwtRegisteredClaimNames.Sub, boundUserId));
            idAgent.AddClaim(new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.NameIdentifier, boundUserId));
        }
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
            if (HasScopeGrant(context, required) || HasDefectShareScopeGrant(context, required, path, method))
            {
                // 仅在通过 scope 门禁后，才把 owner 身份(sub)注入到本次请求的 principal，
                // 让 scope 门禁内的 AdminController（如 document-store）的 GetRequiredUserId() 可用。
                // 这样 owner 身份不会泄漏到任意 [Authorize] 用户端点（P1 安全修复）。
                InjectBoundUserId(context);
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
