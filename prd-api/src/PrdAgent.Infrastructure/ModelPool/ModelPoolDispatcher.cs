using Microsoft.Extensions.Logging;
using PrdAgent.Infrastructure.ModelPool.Models;
using PrdAgent.Infrastructure.ModelPool.Strategies;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// 模型池调度器实现 - 组合策略 + 健康追踪 + HTTP 调度
/// </summary>
public class ModelPoolDispatcher : IModelPool
{
    private readonly string _poolId;
    private readonly string _poolName;
    private readonly IReadOnlyList<PoolEndpoint> _endpoints;
    private readonly IPoolStrategy _strategy;
    private readonly IPoolHealthTracker _healthTracker;
    private readonly IPoolHttpDispatcher _httpDispatcher;
    private readonly ILogger? _logger;

    public ModelPoolDispatcher(
        string poolId,
        string poolName,
        IReadOnlyList<PoolEndpoint> endpoints,
        IPoolStrategy strategy,
        IPoolHealthTracker healthTracker,
        IPoolHttpDispatcher httpDispatcher,
        ILogger? logger = null)
    {
        _poolId = poolId;
        _poolName = poolName;
        _endpoints = endpoints;
        _strategy = strategy;
        _healthTracker = healthTracker;
        _httpDispatcher = httpDispatcher;
        _logger = logger;
    }

    /// <inheritdoc />
    public async Task<PoolResponse> DispatchAsync(PoolRequest request, CancellationToken ct = default)
    {
        if (_endpoints.Count == 0)
            return PoolResponse.Fail("EMPTY_POOL", $"模型池 '{_poolName}' 中没有配置端点", 503);

        _logger?.LogDebug(
            "[ModelPool] 调度开始: Pool={PoolName}, Strategy={Strategy}, Endpoints={Count}, RequestId={RequestId}",
            _poolName, _strategy.StrategyType, _endpoints.Count, request.RequestId);

        try
        {
            var response = await _strategy.ExecuteAsync(
                _endpoints, request, _healthTracker, _httpDispatcher, ct);

            _logger?.LogInformation(
                "[ModelPool] 调度完成: Pool={PoolName}, Strategy={Strategy}, Success={Success}, " +
                "Model={Model}, Duration={Duration}ms, Attempted={Attempted}",
                _poolName, _strategy.StrategyType, response.Success,
                response.DispatchedEndpoint?.ModelId, response.DurationMs, response.EndpointsAttempted);

            return response;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return PoolResponse.Fail("CANCELLED", "请求已取消", 499);
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "[ModelPool] 调度异常: Pool={PoolName}", _poolName);
            return PoolResponse.Fail("POOL_ERROR", ex.Message);
        }
    }

    /// <inheritdoc />
    public IAsyncEnumerable<PoolStreamChunk> DispatchStreamAsync(PoolRequest request, CancellationToken ct = default)
    {
        if (_endpoints.Count == 0)
            return SingleError("模型池中没有配置端点");

        _logger?.LogDebug(
            "[ModelPool] 流式调度开始: Pool={PoolName}, Strategy={Strategy}, Endpoints={Count}",
            _poolName, _strategy.StrategyType, _endpoints.Count);

        return _strategy.ExecuteStreamAsync(_endpoints, request, _healthTracker, _httpDispatcher, ct);
    }

    /// <inheritdoc />
    public async Task<List<PoolTestResult>> TestEndpointsAsync(
        string? endpointId,
        PoolTestRequest? testRequest = null,
        CancellationToken ct = default)
    {
        testRequest ??= new PoolTestRequest();
        var results = new List<PoolTestResult>();
        var endpointsToTest = endpointId != null
            ? _endpoints.Where(ep => ep.EndpointId == endpointId).ToList()
            : _endpoints.ToList();

        foreach (var endpoint in endpointsToTest)
        {
            var startedAt = DateTime.UtcNow;
            try
            {
                var testPoolRequest = new PoolRequest
                {
                    ModelType = testRequest.ModelType,
                    RequestBody = new System.Text.Json.Nodes.JsonObject
                    {
                        ["messages"] = new System.Text.Json.Nodes.JsonArray
                        {
                            new System.Text.Json.Nodes.JsonObject
                            {
                                ["role"] = "user",
                                ["content"] = testRequest.Prompt
                            }
                        },
                        ["max_tokens"] = testRequest.MaxTokens
                    },
                    TimeoutSeconds = testRequest.TimeoutSeconds,
                    RequestId = $"test-{Guid.NewGuid():N}"
                };

                var result = await _httpDispatcher.SendAsync(endpoint, testPoolRequest, ct);
                var latencyMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;

                if (result.IsSuccess)
                    _healthTracker.RecordSuccess(endpoint.EndpointId, latencyMs);
                else
                    _healthTracker.RecordFailure(endpoint.EndpointId);

                var preview = result.ResponseBody?.Length > 500
                    ? result.ResponseBody[..500] + "..."
                    : result.ResponseBody;

                results.Add(new PoolTestResult
                {
                    Success = result.IsSuccess,
                    EndpointId = endpoint.EndpointId,
                    ModelId = endpoint.ModelId,
                    PlatformName = endpoint.PlatformName,
                    StatusCode = result.StatusCode,
                    LatencyMs = latencyMs,
                    ResponsePreview = preview,
                    ErrorMessage = result.ErrorMessage,
                    TokenUsage = result.TokenUsage,
                    TestedAt = DateTime.UtcNow
                });
            }
            catch (Exception ex)
            {
                _healthTracker.RecordFailure(endpoint.EndpointId);
                results.Add(new PoolTestResult
                {
                    Success = false,
                    EndpointId = endpoint.EndpointId,
                    ModelId = endpoint.ModelId,
                    PlatformName = endpoint.PlatformName,
                    LatencyMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds,
                    ErrorMessage = ex.Message,
                    TestedAt = DateTime.UtcNow
                });
            }
        }

        return results;
    }

    /// <inheritdoc />
    public PoolHealthSnapshot GetHealthSnapshot()
    {
        return _healthTracker.GetSnapshot(_endpoints);
    }

    /// <inheritdoc />
    public void ResetEndpointHealth(string endpointId)
    {
        _healthTracker.ResetHealth(endpointId);
    }

    /// <inheritdoc />
    public void ResetAllHealth()
    {
        _healthTracker.ResetAll();
    }

    /// <inheritdoc />
    public ModelPoolConfig GetConfig()
    {
        return new ModelPoolConfig
        {
            PoolId = _poolId,
            PoolName = _poolName,
            Strategy = _strategy.StrategyType,
            Endpoints = _endpoints
        };
    }

    /// <summary>
    /// 创建 ModelPoolDispatcher 的工厂方法
    /// </summary>
    public static ModelPoolDispatcher Create(
        string poolId,
        string poolName,
        IReadOnlyList<PoolEndpoint> endpoints,
        PoolStrategyType strategyType,
        IPoolHttpDispatcher httpDispatcher,
        IPoolHealthTracker? healthTracker = null,
        ILogger? logger = null)
    {
        var strategy = CreateStrategy(strategyType);
        return new ModelPoolDispatcher(
            poolId, poolName, endpoints, strategy,
            healthTracker ?? new PoolHealthTracker(),
            httpDispatcher, logger);
    }

    /// <summary>
    /// 根据策略类型创建策略实例
    /// </summary>
    public static IPoolStrategy CreateStrategy(PoolStrategyType strategyType)
    {
        return strategyType switch
        {
            PoolStrategyType.FailFast => new FailFastStrategy(),
            PoolStrategyType.Race => new RaceStrategy(),
            PoolStrategyType.Sequential => new SequentialStrategy(),
            PoolStrategyType.RoundRobin => new RoundRobinStrategy(),
            PoolStrategyType.WeightedRandom => new WeightedRandomStrategy(),
            PoolStrategyType.LeastLatency => new LeastLatencyStrategy(),
            _ => new FailFastStrategy()
        };
    }

    private static IAsyncEnumerable<PoolStreamChunk> SingleError(string error)
    {
        return SingleErrorCore(error);

        static async IAsyncEnumerable<PoolStreamChunk> SingleErrorCore(string err)
        {
            await Task.CompletedTask;
            yield return PoolStreamChunk.Fail(err);
        }
    }
}
