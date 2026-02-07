using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// 模型池健康追踪器接口
/// 负责追踪端点健康状态、延迟指标
/// </summary>
public interface IPoolHealthTracker
{
    /// <summary>
    /// 记录一次成功调用
    /// </summary>
    void RecordSuccess(string endpointId, long latencyMs);

    /// <summary>
    /// 记录一次失败调用
    /// </summary>
    void RecordFailure(string endpointId);

    /// <summary>
    /// 获取端点健康状态
    /// </summary>
    EndpointHealthStatus GetStatus(string endpointId);

    /// <summary>
    /// 获取端点平均延迟（毫秒）
    /// </summary>
    double GetAverageLatencyMs(string endpointId);

    /// <summary>
    /// 获取端点连续失败次数
    /// </summary>
    int GetConsecutiveFailures(string endpointId);

    /// <summary>
    /// 获取端点健康评分（0-100）
    /// </summary>
    int GetHealthScore(string endpointId);

    /// <summary>
    /// 获取完整的健康快照
    /// </summary>
    PoolHealthSnapshot GetSnapshot(IReadOnlyList<PoolEndpoint> endpoints);

    /// <summary>
    /// 重置端点健康状态为 Healthy
    /// </summary>
    void ResetHealth(string endpointId);

    /// <summary>
    /// 重置所有端点健康状态
    /// </summary>
    void ResetAll();

    /// <summary>
    /// 判断端点是否可用（非 Unavailable）
    /// </summary>
    bool IsAvailable(string endpointId);
}
