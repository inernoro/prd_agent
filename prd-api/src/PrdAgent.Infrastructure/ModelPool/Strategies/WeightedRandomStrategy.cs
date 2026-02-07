using System.Runtime.CompilerServices;
using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool.Strategies;

/// <summary>
/// 加权随机型策略：按优先级权重随机选择模型
/// - 权重 = 1.0 / Priority（优先级越小权重越大）
/// - 健康状态影响权重（降级端点权重减半）
/// - 统计学上按比例分配请求
/// </summary>
public class WeightedRandomStrategy : IPoolStrategy
{
    private readonly Random _random = new();

    public PoolStrategyType StrategyType => PoolStrategyType.WeightedRandom;

    public async Task<PoolResponse> ExecuteAsync(
        IReadOnlyList<PoolEndpoint> endpoints,
        PoolRequest request,
        IPoolHealthTracker healthTracker,
        IPoolHttpDispatcher httpDispatcher,
        CancellationToken ct = default)
    {
        var available = StrategyHelper.GetAvailableEndpoints(endpoints, healthTracker);
        if (available.Count == 0)
            return StrategyHelper.NoAvailableEndpoints(StrategyType);

        var selected = SelectWeighted(available, healthTracker);

        var result = await httpDispatcher.SendAsync(selected, request, ct);

        if (result.IsSuccess)
            healthTracker.RecordSuccess(selected.EndpointId, result.LatencyMs);
        else
            healthTracker.RecordFailure(selected.EndpointId);

        return StrategyHelper.ToPoolResponse(result, selected, StrategyType);
    }

    public async IAsyncEnumerable<PoolStreamChunk> ExecuteStreamAsync(
        IReadOnlyList<PoolEndpoint> endpoints,
        PoolRequest request,
        IPoolHealthTracker healthTracker,
        IPoolHttpDispatcher httpDispatcher,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var available = StrategyHelper.GetAvailableEndpoints(endpoints, healthTracker);
        if (available.Count == 0)
        {
            yield return PoolStreamChunk.Fail("模型池内无可用端点");
            yield break;
        }

        var selected = SelectWeighted(available, healthTracker);
        var startedAt = DateTime.UtcNow;

        yield return PoolStreamChunk.Start(StrategyHelper.ToDispatchedInfo(selected));

        await foreach (var chunk in httpDispatcher.SendStreamAsync(selected, request, ct))
        {
            if (chunk.Type == PoolChunkType.Error)
                healthTracker.RecordFailure(selected.EndpointId);
            else if (chunk.Type == PoolChunkType.Done)
                healthTracker.RecordSuccess(selected.EndpointId, (long)(DateTime.UtcNow - startedAt).TotalMilliseconds);

            yield return chunk;
        }
    }

    private PoolEndpoint SelectWeighted(List<PoolEndpoint> available, IPoolHealthTracker healthTracker)
    {
        if (available.Count == 1)
            return available[0];

        // 计算权重：1.0 / Priority，降级端点权重减半
        var weights = available.Select(ep =>
        {
            var baseWeight = 1.0 / Math.Max(ep.Priority, 1);
            var status = healthTracker.GetStatus(ep.EndpointId);
            return status == EndpointHealthStatus.Degraded ? baseWeight * 0.5 : baseWeight;
        }).ToList();

        var totalWeight = weights.Sum();
        var roll = _random.NextDouble() * totalWeight;
        var cumulative = 0.0;

        for (int i = 0; i < available.Count; i++)
        {
            cumulative += weights[i];
            if (roll <= cumulative)
                return available[i];
        }

        return available[^1]; // 兜底
    }
}
