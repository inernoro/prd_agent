using System.Runtime.CompilerServices;
using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool.Strategies;

/// <summary>
/// 顺序型策略：按优先级依次请求，失败则顺延到下一个模型
/// - 按健康状态 + 优先级排序
/// - 失败后自动尝试下一个端点
/// - 直到成功或所有端点用尽
/// </summary>
public class SequentialStrategy : IPoolStrategy
{
    public PoolStrategyType StrategyType => PoolStrategyType.Sequential;

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

        var errors = new List<string>();
        var attempted = 0;

        foreach (var endpoint in available)
        {
            attempted++;
            try
            {
                var result = await httpDispatcher.SendAsync(endpoint, request, ct);

                if (result.IsSuccess)
                {
                    healthTracker.RecordSuccess(endpoint.EndpointId, result.LatencyMs);
                    return StrategyHelper.ToPoolResponse(result, endpoint, StrategyType, attempted);
                }

                healthTracker.RecordFailure(endpoint.EndpointId);
                errors.Add($"{endpoint.ModelId}@{endpoint.PlatformName ?? endpoint.PlatformId}: {result.ErrorMessage ?? $"HTTP {result.StatusCode}"}");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw; // 外部取消，不重试
            }
            catch (Exception ex)
            {
                healthTracker.RecordFailure(endpoint.EndpointId);
                errors.Add($"{endpoint.ModelId}@{endpoint.PlatformName ?? endpoint.PlatformId}: {ex.Message}");
            }
        }

        // 所有端点都失败
        var errorSummary = string.Join("; ", errors);
        return new PoolResponse
        {
            Success = false,
            StatusCode = 502,
            ErrorCode = "ALL_ENDPOINTS_FAILED",
            ErrorMessage = $"Sequential 模式下所有端点失败 ({attempted} 个): {errorSummary}",
            StrategyUsed = StrategyType,
            EndpointsAttempted = attempted
        };
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

        var errors = new List<string>();

        foreach (var endpoint in available)
        {
            var startedAt = DateTime.UtcNow;
            bool success = false;
            bool hasError = false;
            var chunks = new List<PoolStreamChunk>();

            try
            {
                await foreach (var chunk in httpDispatcher.SendStreamAsync(endpoint, request, ct))
                {
                    if (chunk.Type == PoolChunkType.Error)
                    {
                        hasError = true;
                        healthTracker.RecordFailure(endpoint.EndpointId);
                        errors.Add($"{endpoint.ModelId}: {chunk.Error}");
                        break;
                    }

                    chunks.Add(chunk);

                    if (chunk.Type == PoolChunkType.Done)
                    {
                        success = true;
                        var latencyMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                        healthTracker.RecordSuccess(endpoint.EndpointId, latencyMs);
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                hasError = true;
                healthTracker.RecordFailure(endpoint.EndpointId);
                errors.Add($"{endpoint.ModelId}: {ex.Message}");
            }

            if (success)
            {
                // 成功，输出所有收集到的块
                yield return PoolStreamChunk.Start(StrategyHelper.ToDispatchedInfo(endpoint));
                foreach (var chunk in chunks)
                    yield return chunk;
                yield break;
            }

            // 失败，尝试下一个端点
        }

        // 所有端点都失败
        var errorSummary = string.Join("; ", errors);
        yield return PoolStreamChunk.Fail($"Sequential 模式下所有端点失败: {errorSummary}");
    }
}
