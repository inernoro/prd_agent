using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool.Strategies;

/// <summary>
/// 策略共享的辅助方法
/// </summary>
internal static class StrategyHelper
{
    /// <summary>
    /// 过滤并排序可用端点（排除 Unavailable，按健康状态 + 优先级排序）
    /// </summary>
    public static List<PoolEndpoint> GetAvailableEndpoints(
        IReadOnlyList<PoolEndpoint> endpoints,
        IPoolHealthTracker healthTracker)
    {
        return endpoints
            .Where(ep => healthTracker.IsAvailable(ep.EndpointId))
            .OrderBy(ep => healthTracker.GetStatus(ep.EndpointId) == EndpointHealthStatus.Healthy ? 0 : 1)
            .ThenBy(ep => ep.Priority)
            .ToList();
    }

    /// <summary>
    /// 将 PoolHttpResult 转换为 PoolResponse
    /// </summary>
    public static PoolResponse ToPoolResponse(
        PoolHttpResult httpResult,
        PoolEndpoint endpoint,
        PoolStrategyType strategyType,
        int endpointsAttempted = 1)
    {
        return new PoolResponse
        {
            Success = httpResult.IsSuccess,
            StatusCode = httpResult.StatusCode,
            Content = httpResult.ResponseBody,
            ErrorCode = httpResult.IsSuccess ? null : "ENDPOINT_ERROR",
            ErrorMessage = httpResult.ErrorMessage,
            DispatchedEndpoint = ToDispatchedInfo(endpoint),
            DurationMs = httpResult.LatencyMs,
            StrategyUsed = strategyType,
            EndpointsAttempted = endpointsAttempted
        };
    }

    /// <summary>
    /// 构建 DispatchedEndpointInfo
    /// </summary>
    public static DispatchedEndpointInfo ToDispatchedInfo(PoolEndpoint endpoint)
    {
        return new DispatchedEndpointInfo
        {
            EndpointId = endpoint.EndpointId,
            ModelId = endpoint.ModelId,
            PlatformId = endpoint.PlatformId,
            PlatformName = endpoint.PlatformName,
            PlatformType = endpoint.PlatformType,
            ApiUrl = endpoint.ApiUrl
        };
    }

    /// <summary>
    /// 无可用端点时的错误响应
    /// </summary>
    public static PoolResponse NoAvailableEndpoints(PoolStrategyType strategyType)
    {
        return new PoolResponse
        {
            Success = false,
            StatusCode = 503,
            ErrorCode = "NO_AVAILABLE_ENDPOINTS",
            ErrorMessage = "模型池内无可用端点",
            StrategyUsed = strategyType
        };
    }
}
