using System.Runtime.CompilerServices;
using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool.Strategies;

/// <summary>
/// 轮询型策略：在健康模型间轮转，均匀分配负载
/// - 维护一个原子计数器，每次请求递增
/// - 跳过不可用的端点
/// - 保证在健康端点间均匀分配
/// </summary>
public class RoundRobinStrategy : IPoolStrategy
{
    private int _counter;

    public PoolStrategyType StrategyType => PoolStrategyType.RoundRobin;

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

        // 原子递增并取模
        var index = Interlocked.Increment(ref _counter);
        var selected = available[((index % available.Count) + available.Count) % available.Count];

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

        var index = Interlocked.Increment(ref _counter);
        var selected = available[((index % available.Count) + available.Count) % available.Count];
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
}
