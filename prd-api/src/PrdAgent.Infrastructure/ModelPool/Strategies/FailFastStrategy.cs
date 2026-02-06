using System.Runtime.CompilerServices;
using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool.Strategies;

/// <summary>
/// 默认型策略：选最优模型，请求失败直接返回错误
/// - 选择健康状态最好 + 优先级最高的端点
/// - 不重试、不顺延
/// </summary>
public class FailFastStrategy : IPoolStrategy
{
    public PoolStrategyType StrategyType => PoolStrategyType.FailFast;

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

        var endpoint = available[0];
        var result = await httpDispatcher.SendAsync(endpoint, request, ct);

        if (result.IsSuccess)
            healthTracker.RecordSuccess(endpoint.EndpointId, result.LatencyMs);
        else
            healthTracker.RecordFailure(endpoint.EndpointId);

        return StrategyHelper.ToPoolResponse(result, endpoint, StrategyType);
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

        var endpoint = available[0];
        var startedAt = DateTime.UtcNow;

        yield return PoolStreamChunk.Start(StrategyHelper.ToDispatchedInfo(endpoint));

        await foreach (var chunk in httpDispatcher.SendStreamAsync(endpoint, request, ct))
        {
            if (chunk.Type == PoolChunkType.Error)
            {
                healthTracker.RecordFailure(endpoint.EndpointId);
                yield return chunk;
                yield break;
            }

            yield return chunk;

            if (chunk.Type == PoolChunkType.Done)
            {
                var latencyMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                healthTracker.RecordSuccess(endpoint.EndpointId, latencyMs);
            }
        }
    }
}
