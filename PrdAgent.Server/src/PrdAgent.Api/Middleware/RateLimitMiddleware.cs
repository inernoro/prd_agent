using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 速率限制中间件
/// </summary>
public class RateLimitMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<RateLimitMiddleware> _logger;
    private readonly ConcurrentDictionary<string, RateLimitInfo> _clients = new();
    private readonly int _maxRequestsPerMinute;
    private readonly int _maxConcurrentRequests;

    public RateLimitMiddleware(
        RequestDelegate next, 
        ILogger<RateLimitMiddleware> logger,
        int maxRequestsPerMinute = 60,
        int maxConcurrentRequests = 10)
    {
        _next = next;
        _logger = logger;
        _maxRequestsPerMinute = maxRequestsPerMinute;
        _maxConcurrentRequests = maxConcurrentRequests;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var clientId = GetClientId(context);
        var info = _clients.GetOrAdd(clientId, _ => new RateLimitInfo());

        // 清理过期记录
        info.CleanupOldRequests();

        // 检查并发限制
        if (info.ConcurrentRequests >= _maxConcurrentRequests)
        {
            await RejectRequest(context, "并发请求过多，请稍后再试");
            return;
        }

        // 检查频率限制
        if (info.RequestsInLastMinute >= _maxRequestsPerMinute)
        {
            await RejectRequest(context, "请求频率过高，请稍后再试");
            return;
        }

        // 记录请求
        info.AddRequest();
        Interlocked.Increment(ref info.ConcurrentRequests);

        try
        {
            await _next(context);
        }
        finally
        {
            Interlocked.Decrement(ref info.ConcurrentRequests);
        }
    }

    private string GetClientId(HttpContext context)
    {
        // 优先使用用户ID，其次使用IP
        var userId = context.User?.FindFirst("sub")?.Value;
        if (!string.IsNullOrEmpty(userId))
            return $"user:{userId}";

        var ip = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return $"ip:{ip}";
    }

    private async Task RejectRequest(HttpContext context, string message)
    {
        context.Response.StatusCode = (int)HttpStatusCode.TooManyRequests;
        context.Response.ContentType = "application/json";

        var response = ApiResponse<object>.Fail(ErrorCodes.RATE_LIMITED, message);
        var json = JsonSerializer.Serialize(response, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });

        await context.Response.WriteAsync(json);
    }
}

/// <summary>
/// 速率限制信息
/// </summary>
public class RateLimitInfo
{
    private readonly ConcurrentQueue<DateTime> _requestTimes = new();
    public int ConcurrentRequests;

    public int RequestsInLastMinute
    {
        get
        {
            CleanupOldRequests();
            return _requestTimes.Count;
        }
    }

    public void AddRequest()
    {
        _requestTimes.Enqueue(DateTime.UtcNow);
    }

    public void CleanupOldRequests()
    {
        var cutoff = DateTime.UtcNow.AddMinutes(-1);
        while (_requestTimes.TryPeek(out var time) && time < cutoff)
        {
            _requestTimes.TryDequeue(out _);
        }
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

