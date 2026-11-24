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

        // 这里**不能**按 sk-ak 的密钥 id 分桶，尽管那看起来更合理。原因在管线顺序上：
        // UseAuthentication() 只跑默认方案（JWT），ApiKey 是端点上显式指定的非默认方案，
        // 要等 UseAuthorization() 才被选中，而它排在本中间件之后。所以这一刻 context.User
        // 里根本没有 agentApiKeyId —— 曾经在这里加过一条 agentkey 分支，它一次也没生效过，
        // 是条看着对、永远走不到的死路（第 31 轮 Review 指出）。
        //
        // 那「每把密钥各算各的」怎么办？它由另一层兑现：接入台的每分钟窗口
        // （McpUsageService.CheckRateAsync，默认 60/min，可按密钥调），那一层跑在鉴权之后，
        // 拿得到密钥身份，网关与直连两条路都过它。本中间件是更粗的防滥用层，按 IP 分桶。
        // 想让它也认密钥，得把 ApiKey 并进默认认证方案（policy scheme 按 token 前缀转发），
        // 那会改变全站每个端点看到的身份，是另一个语义类别 —— 见 debt.platform 边界 15。

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
