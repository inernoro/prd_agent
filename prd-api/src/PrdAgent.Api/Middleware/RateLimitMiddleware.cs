using System.Net;
using System.Text.Json;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Json;
using PrdAgent.Api.Services.Mcp;
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

    public async Task InvokeAsync(HttpContext context, IRateLimitService rateLimitService,
        McpLoopbackSignal loopback)
    {
        // MCP 网关的回环续跳：外层那一跳已经计过一次，这里再计一次等于一次工具调用占两格。
        // 更要命的是续跳的对端恒为 127.0.0.1 —— sk-ak 身份故意不带 sub，分桶会落到 IP 上，
        // 于是所有密钥挤进同一个回环桶，一把密钥刷满就把别人的调用一起 429 掉。
        if (loopback.IsGatewayContinuation(context.Request))
        {
            await _next(context);
            return;
        }

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

        // sk-ak（智能体密钥）故意不带 sub —— 它不是「某个人在操作」。落到 IP 桶的话，同一个出口
        // 地址后面的所有密钥共用一份配额，而密钥 id 来自鉴权结果、调用方伪造不了，用它分桶才是
        // 接入台上写的那句「每把密钥各算各的」。只认 agentApiKeyId：老的开放平台 appId 密钥维持
        // 原样，不在这次改动里改它们的分桶行为。
        var agentKeyId = context.User?.FindFirst("agentApiKeyId")?.Value;
        if (!string.IsNullOrEmpty(agentKeyId))
            return $"agentkey:{agentKeyId}";

        // 走 GetAbuseControlClientIp 而不是裸的 RemoteIpAddress：生产是 Nginx + Docker，
        // 裸取到的是反代共享地址，所有匿名访客共用一个桶 —— 海鲜市场的读接口 2026-07-28
        // 改匿名之后，一个忙碌客户端就能让所有人的列表/详情/标签/下载 429。
        //
        // 也不走 GetRealClientIp（那条无条件采信 X-Real-IP，只适合展示/统计）：分桶是安全
        // 控制，无条件采信等于让调用方自选桶键，每个请求换一个头就是一份新配额。
        // GetAbuseControlClientIp 只在对端是回环/私网（即我方反代）时才采信该头。
        var ip = context.GetAbuseControlClientIp() ?? "unknown";
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
