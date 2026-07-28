using System.Net;
using System.Text.Json;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 速率限制中间件（基于 Redis 的分布式限流）
/// </summary>
public class RateLimitMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<RateLimitMiddleware> _logger;

    public RateLimitMiddleware(
        RequestDelegate next,
        ILogger<RateLimitMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context, IRateLimitService rateLimitService)
    {
        var clientId = GetClientId(context);

        // 检查是否为 root 用户（豁免限流）
        if (IsRoot(context))
        {
            _logger.LogDebug("Root user bypassed rate limiting: {ClientId}", clientId);
            await _next(context);
            return;
        }

        // 检查用户是否在豁免列表中
        var userId = context.User?.FindFirst("sub")?.Value;
        if (!string.IsNullOrEmpty(userId))
        {
            var isExempt = await rateLimitService.IsExemptAsync(userId);
            if (isExempt)
            {
                _logger.LogDebug("Exempt user bypassed rate limiting: {UserId}", userId);
                await _next(context);
                return;
            }
        }

        // 执行限流检查
        var (allowed, reason) = await rateLimitService.CheckRequestAsync(clientId);

        if (!allowed)
        {
            _logger.LogWarning("Rate limit exceeded for {ClientId}: {Reason}", clientId, reason);
            await RejectRequest(context, reason ?? "请求被限制");
            return;
        }

        try
        {
            await _next(context);
        }
        finally
        {
            // 请求完成后减少并发计数
            await rateLimitService.RequestCompletedAsync(clientId);
        }
    }

    private static bool IsRoot(HttpContext context)
    {
        return string.Equals(context.User?.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);
    }

    private static string GetClientId(HttpContext context)
    {
        // 优先使用用户ID，其次使用IP
        var userId = context.User?.FindFirst("sub")?.Value;
        if (!string.IsNullOrEmpty(userId))
            return $"user:{userId}";

        // 必须走 GetRealClientIp：生产是 Nginx + Docker，裸的 RemoteIpAddress 是反代的
        // 共享地址，所有匿名访客会被算成同一个 clientId 共用一个桶 —— 海鲜市场的读接口
        // 2026-07-28 改匿名之后，一个忙碌客户端就能让所有人的列表/详情/标签/下载 429。
        // GetRealClientIp 只信反代覆盖的 X-Real-IP，取不到时仍回落到 RemoteIpAddress。
        var ip = context.GetRealClientIp() ?? "unknown";
        return $"ip:{ip}";
    }

    private static async Task RejectRequest(HttpContext context, string message)
    {
        context.Response.StatusCode = (int)HttpStatusCode.TooManyRequests;
        context.Response.ContentType = "application/json";

        var response = ApiResponse<object>.Fail(ErrorCodes.RATE_LIMITED, message);
        var json = JsonSerializer.Serialize(response, AppJsonContext.Default.ApiResponseObject);

        await context.Response.WriteAsync(json);
    }
}

/// <summary>
/// 扩展方法
/// </summary>
public static class RateLimitMiddlewareExtensions
{
    public static IApplicationBuilder UseRateLimiting(this IApplicationBuilder builder)
    {
        return builder.UseMiddleware<RateLimitMiddleware>();
    }
}
