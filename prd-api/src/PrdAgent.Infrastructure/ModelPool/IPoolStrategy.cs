using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// 模型池调度策略接口
/// 不同策略决定如何选择端点、是否重试/并发
/// </summary>
public interface IPoolStrategy
{
    /// <summary>
    /// 策略类型标识
    /// </summary>
    PoolStrategyType StrategyType { get; }

    /// <summary>
    /// 执行调度：选择端点并发送请求
    /// </summary>
    /// <param name="endpoints">可用端点列表（已按健康状态和优先级排序）</param>
    /// <param name="request">调度请求</param>
    /// <param name="healthTracker">健康追踪器</param>
    /// <param name="httpDispatcher">HTTP 请求执行器</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>调度响应</returns>
    Task<PoolResponse> ExecuteAsync(
        IReadOnlyList<PoolEndpoint> endpoints,
        PoolRequest request,
        IPoolHealthTracker healthTracker,
        IPoolHttpDispatcher httpDispatcher,
        CancellationToken ct = default);

    /// <summary>
    /// 执行流式调度
    /// </summary>
    IAsyncEnumerable<PoolStreamChunk> ExecuteStreamAsync(
        IReadOnlyList<PoolEndpoint> endpoints,
        PoolRequest request,
        IPoolHealthTracker healthTracker,
        IPoolHttpDispatcher httpDispatcher,
        CancellationToken ct = default);
}
