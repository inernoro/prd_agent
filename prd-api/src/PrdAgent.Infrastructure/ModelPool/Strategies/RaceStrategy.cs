using System.Runtime.CompilerServices;
using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool.Strategies;

/// <summary>
/// 演示型策略：一次性请求所有模型，挑最快返回的成功结果
/// - 并发请求所有可用端点
/// - 返回第一个成功响应
/// - 取消其他进行中的请求
/// - 适合 Demo 和低延迟要求场景
/// </summary>
public class RaceStrategy : IPoolStrategy
{
    public PoolStrategyType StrategyType => PoolStrategyType.Race;

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

        // 只有一个端点，直接请求
        if (available.Count == 1)
        {
            var ep = available[0];
            var result = await httpDispatcher.SendAsync(ep, request, ct);
            if (result.IsSuccess)
                healthTracker.RecordSuccess(ep.EndpointId, result.LatencyMs);
            else
                healthTracker.RecordFailure(ep.EndpointId);
            return StrategyHelper.ToPoolResponse(result, ep, StrategyType, 1);
        }

        // 并发请求所有端点
        using var raceCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var tasks = available.Select(ep => RaceOneAsync(ep, request, httpDispatcher, raceCts.Token)).ToList();

        PoolEndpoint? winnerEndpoint = null;
        PoolHttpResult? winnerResult = null;
        var errors = new List<(PoolEndpoint ep, string error)>();

        // 用 WhenAny 模式获取第一个成功的
        while (tasks.Count > 0)
        {
            var completed = await Task.WhenAny(tasks);
            tasks.Remove(completed);

            var (ep, result) = await completed;
            if (result.IsSuccess)
            {
                winnerEndpoint = ep;
                winnerResult = result;
                healthTracker.RecordSuccess(ep.EndpointId, result.LatencyMs);
                // 取消其余请求
                raceCts.Cancel();
                break;
            }
            else
            {
                healthTracker.RecordFailure(ep.EndpointId);
                errors.Add((ep, result.ErrorMessage ?? "Unknown error"));
            }
        }

        if (winnerEndpoint != null && winnerResult != null)
        {
            return StrategyHelper.ToPoolResponse(winnerResult, winnerEndpoint, StrategyType, available.Count);
        }

        // 所有端点都失败了
        var errorSummary = string.Join("; ", errors.Select(e => $"{e.ep.ModelId}: {e.error}"));
        return new PoolResponse
        {
            Success = false,
            StatusCode = 502,
            ErrorCode = "ALL_ENDPOINTS_FAILED",
            ErrorMessage = $"Race 模式下所有端点失败: {errorSummary}",
            StrategyUsed = StrategyType,
            EndpointsAttempted = available.Count
        };
    }

    public async IAsyncEnumerable<PoolStreamChunk> ExecuteStreamAsync(
        IReadOnlyList<PoolEndpoint> endpoints,
        PoolRequest request,
        IPoolHealthTracker healthTracker,
        IPoolHttpDispatcher httpDispatcher,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        // 流式 Race：与非流式类似，但只能取第一个开始产出的流
        // 实现方式：并发启动所有流，第一个产出 Text 块的流胜出，取消其他
        var available = StrategyHelper.GetAvailableEndpoints(endpoints, healthTracker);
        if (available.Count == 0)
        {
            yield return PoolStreamChunk.Fail("模型池内无可用端点");
            yield break;
        }

        if (available.Count == 1)
        {
            var ep = available[0];
            var startedAt = DateTime.UtcNow;
            yield return PoolStreamChunk.Start(StrategyHelper.ToDispatchedInfo(ep));

            await foreach (var chunk in httpDispatcher.SendStreamAsync(ep, request, ct))
            {
                if (chunk.Type == PoolChunkType.Error)
                    healthTracker.RecordFailure(ep.EndpointId);
                else if (chunk.Type == PoolChunkType.Done)
                    healthTracker.RecordSuccess(ep.EndpointId, (long)(DateTime.UtcNow - startedAt).TotalMilliseconds);

                yield return chunk;
            }
            yield break;
        }

        // 对于多端点流式 Race，回退到非流式 Race + 整体返回
        // 因为真正的流式 Race 需要复杂的通道管理
        var response = await ExecuteAsync(endpoints, request, healthTracker, httpDispatcher, ct);
        if (!response.Success)
        {
            yield return PoolStreamChunk.Fail(response.ErrorMessage ?? "Race failed");
            yield break;
        }

        if (response.DispatchedEndpoint != null)
            yield return PoolStreamChunk.Start(response.DispatchedEndpoint);

        if (!string.IsNullOrEmpty(response.Content))
            yield return PoolStreamChunk.Text(response.Content);

        yield return PoolStreamChunk.Done(null, null);
    }

    private static async Task<(PoolEndpoint endpoint, PoolHttpResult result)> RaceOneAsync(
        PoolEndpoint endpoint,
        PoolRequest request,
        IPoolHttpDispatcher httpDispatcher,
        CancellationToken ct)
    {
        try
        {
            var result = await httpDispatcher.SendAsync(endpoint, request, ct);
            return (endpoint, result);
        }
        catch (OperationCanceledException)
        {
            return (endpoint, PoolHttpResult.Fail("Cancelled by race winner", 0));
        }
        catch (Exception ex)
        {
            return (endpoint, PoolHttpResult.Fail(ex.Message));
        }
    }
}
