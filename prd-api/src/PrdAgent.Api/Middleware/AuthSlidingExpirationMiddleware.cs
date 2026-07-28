using PrdAgent.Core.Interfaces;
using System.IdentityModel.Tokens.Jwt;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 对已鉴权请求做滑动过期（默认 7 天，见 <c>Auth:SessionSlidingDays</c>）：按端独立（clientType + sessionKey）。
/// </summary>
public class AuthSlidingExpirationMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<AuthSlidingExpirationMiddleware> _logger;

    public AuthSlidingExpirationMiddleware(RequestDelegate next, ILogger<AuthSlidingExpirationMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task Invoke(HttpContext context, IAuthSessionService authSessionService, ICacheManager cache)
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

                var clientId = (context.Request.Headers["X-Client-Id"].ToString() ?? "").Trim();
                if (string.IsNullOrWhiteSpace(clientId))
                {
                    clientId = sessionKey;
                }

                if (!string.IsNullOrWhiteSpace(clientId))
                {
                    var key = CacheKeys.ForAuthClientBinding(userId, clientType, sessionKey);
                    // 客户端绑定与会话共用同一个滑动窗口，避免绑定先于会话过期。
                    var clientBindingTtl = authSessionService.SlidingTtl;
                    try
                    {
                        var existing = await cache.GetAsync<string>(key);
                        if (string.IsNullOrWhiteSpace(existing))
                        {
                            await cache.SetAsync(key, clientId, clientBindingTtl);
                        }
                        else if (!string.Equals(existing, clientId, StringComparison.Ordinal))
                        {
                            _logger.LogWarning("ClientId binding mismatch: userId={UserId} clientType={ClientType} sessionKey={SessionKey} existing={Existing} current={Current}",
                                userId, clientType, sessionKey, existing, clientId);
                        }
                    }
                    catch
                    {
                        // 绑定失败不影响主流程
                    }
                }
            }
        }

        await _next(context);
    }
}


