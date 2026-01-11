using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 对“写请求”更新 users.lastActiveAt（最后操作时间）。
/// 目的：统一覆盖未来新增功能，避免逐个控制器手动补点。
/// </summary>
public class UserLastActiveMiddleware
{
    private readonly RequestDelegate _next;

    public UserLastActiveMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task Invoke(HttpContext context, IUserService userService)
    {
        await _next(context);

        // 仅对已认证请求 touch；不影响未登录/预检
        if (context.User?.Identity?.IsAuthenticated != true) return;

        // 仅写操作：避免“打开页面/轮询”把最后操作时间刷掉
        if (HttpMethods.IsGet(context.Request.Method) ||
            HttpMethods.IsHead(context.Request.Method) ||
            HttpMethods.IsOptions(context.Request.Method))
        {
            return;
        }

        // 仅在请求成功时 touch（4xx/5xx 不算有效操作）
        if (context.Response?.StatusCode >= 400) return;

        var userId = context.User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
                     ?? context.User.FindFirst("sub")?.Value
                     ?? context.User.FindFirst(ClaimTypes.NameIdentifier)?.Value
                     ?? context.User.FindFirst("nameid")?.Value;

        if (string.IsNullOrWhiteSpace(userId)) return;

        // 不阻塞主请求：Mongo/网络抖动不影响业务调用
        _ = userService.UpdateLastActiveAsync(userId, DateTime.UtcNow);
    }
}

