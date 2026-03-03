using PrdAgent.Core.Interfaces;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 在每个 API 响应中注入 X-Perm-Fingerprint 头。
/// 前端据此判断权限目录或角色定义是否已变更（如新部署、角色 CRUD），
/// 若指纹不一致则自动刷新权限缓存，避免频繁发版导致"权限不足"的问题。
/// </summary>
public sealed class PermissionFingerprintMiddleware
{
    private readonly RequestDelegate _next;

    public PermissionFingerprintMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task Invoke(HttpContext context, ISystemRoleCacheService roleCache)
    {
        context.Response.OnStarting(() =>
        {
            var fp = roleCache.GetFingerprint();
            if (!string.IsNullOrEmpty(fp))
            {
                context.Response.Headers["X-Perm-Fingerprint"] = fp;
            }
            return Task.CompletedTask;
        });

        await _next(context);
    }
}
