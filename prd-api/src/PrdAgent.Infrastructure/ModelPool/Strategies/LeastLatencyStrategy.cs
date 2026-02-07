using System.Runtime.CompilerServices;
using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool.Strategies;

/// <summary>
/// 最低延迟型策略：跟踪平均延迟，总是选最快的模型
/// - 基于滑动窗口的平均延迟指标
/// - 新端点（无延迟数据）优先尝试（探索）
/// - 在已知端点中选择平均延迟最低的
/// </summary>
public class LeastLatencyStrategy : IPoolStrategy
{
    public PoolStrategyType StrategyType => PoolStrategyType.LeastLatency;

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

        var selected = SelectByLatency(available, healthTracker);

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

        var selected = SelectByLatency(available, healthTracker);
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

    private static PoolEndpoint SelectByLatency(
        List<PoolEndpoint> available,
        IPoolHealthTracker healthTracker)
    {
        if (available.Count == 1)
            return available[0];

        // 新端点（无延迟数据）优先探索
        var unexplored = available.Where(ep => healthTracker.GetAverageLatencyMs(ep.EndpointId) == 0).ToList();
        if (unexplored.Count > 0)
            return unexplored.OrderBy(ep => ep.Priority).First();

        // 在已知端点中选择平均延迟最低的
        return available
            .OrderBy(ep => healthTracker.GetAverageLatencyMs(ep.EndpointId))
            .ThenBy(ep => ep.Priority)
            .First();
    }
}
