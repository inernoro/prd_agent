namespace PrdAgent.Infrastructure.ModelPool.Models;

/// <summary>
/// 模型池健康快照 - 当前时刻的池状态
/// </summary>
public class PoolHealthSnapshot
{
    /// <summary>端点健康状态列表</summary>
    public List<EndpointHealthInfo> Endpoints { get; init; } = new();

    /// <summary>健康端点数</summary>
    public int HealthyCount => Endpoints.Count(e => e.Status == EndpointHealthStatus.Healthy);

    /// <summary>降级端点数</summary>
    public int DegradedCount => Endpoints.Count(e => e.Status == EndpointHealthStatus.Degraded);

    /// <summary>不可用端点数</summary>
    public int UnavailableCount => Endpoints.Count(e => e.Status == EndpointHealthStatus.Unavailable);

    /// <summary>总端点数</summary>
    public int TotalCount => Endpoints.Count;

    /// <summary>池是否完全不可用</summary>
    public bool IsFullyUnavailable => HealthyCount == 0 && DegradedCount == 0;
}

/// <summary>
/// 单个端点健康信息
/// </summary>
public class EndpointHealthInfo
{
    /// <summary>端点 ID</summary>
    public string EndpointId { get; init; } = string.Empty;

    /// <summary>模型 ID</summary>
    public string ModelId { get; init; } = string.Empty;

    /// <summary>健康状态</summary>
    public EndpointHealthStatus Status { get; init; }

    /// <summary>连续失败次数</summary>
    public int ConsecutiveFailures { get; init; }

    /// <summary>连续成功次数</summary>
    public int ConsecutiveSuccesses { get; init; }

    /// <summary>最后成功时间</summary>
    public DateTime? LastSuccessAt { get; init; }

    /// <summary>最后失败时间</summary>
    public DateTime? LastFailedAt { get; init; }

    /// <summary>平均延迟（毫秒），用于 LeastLatency 策略</summary>
    public double? AverageLatencyMs { get; init; }

    /// <summary>健康评分 0-100</summary>
    public int HealthScore { get; init; }
}

/// <summary>
/// 端点健康状态
/// </summary>
public enum EndpointHealthStatus
{
    /// <summary>健康</summary>
    Healthy = 0,

    /// <summary>降级（仍可用但优先级降低）</summary>
    Degraded = 1,

    /// <summary>不可用（暂时跳过）</summary>
    Unavailable = 2
}
