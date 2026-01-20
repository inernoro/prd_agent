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
