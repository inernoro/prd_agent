using PrdAgent.Core.Interfaces;
using System.IdentityModel.Tokens.Jwt;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 对已鉴权请求做“3天滑动过期”（now+72h）：按端独立（clientType + sessionKey）。
/// </summary>
public class AuthSlidingExpirationMiddleware
{
    private readonly RequestDelegate _next;

    public AuthSlidingExpirationMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task Invoke(HttpContext context, IAuthSessionService authSessionService)
    {
        // 仅对已认证用户 touch；不影响未登录/预检
        if (context.User?.Identity?.IsAuthenticated == true)
        {
            var userId = context.User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value;
            var clientType = context.User.FindFirst("clientType")?.Value;
            var sessionKey = context.User.FindFirst("sessionKey")?.Value;

            if (!string.IsNullOrWhiteSpace(userId) &&
                !string.IsNullOrWhiteSpace(clientType) &&
                !string.IsNullOrWhiteSpace(sessionKey))
            {
                // 不阻塞主请求：touch 失败（Redis 短暂抖动）不影响用户正常调用
                _ = authSessionService.TouchAsync(userId, clientType, sessionKey);
            }
        }

        await _next(context);
    }
}


