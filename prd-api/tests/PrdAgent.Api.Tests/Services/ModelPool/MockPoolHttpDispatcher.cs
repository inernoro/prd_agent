using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using PrdAgent.Infrastructure.ModelPool;
using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Api.Tests.Services.ModelPool;

/// <summary>
/// 可编程的 Mock HTTP 调度器
/// 支持按端点配置延迟、成功/失败、自定义响应
/// </summary>
public class MockPoolHttpDispatcher : IPoolHttpDispatcher
{
    private readonly Dictionary<string, EndpointBehavior> _behaviors = new();
    private readonly List<DispatchRecord> _records = new();
    private readonly object _lock = new();

    /// <summary>已调度的请求记录</summary>
    public IReadOnlyList<DispatchRecord> Records
    {
        get { lock (_lock) return _records.ToList(); }
    }

    /// <summary>配置端点行为</summary>
    public MockPoolHttpDispatcher WithEndpoint(string endpointId, EndpointBehavior behavior)
    {
        _behaviors[endpointId] = behavior;
        return this;
    }

    /// <summary>配置所有端点成功（默认行为）</summary>
    public MockPoolHttpDispatcher WithDefaultSuccess(int latencyMs = 0, string content = "{\"ok\":true}")
    {
        _behaviors["*"] = new EndpointBehavior { LatencyMs = latencyMs, ResponseBody = content };
        return this;
    }

    /// <summary>配置所有端点失败</summary>
    public MockPoolHttpDispatcher WithDefaultFailure(string error = "Mock error", int statusCode = 500)
    {
        _behaviors["*"] = new EndpointBehavior { ShouldFail = true, ErrorMessage = error, StatusCode = statusCode };
        return this;
    }

    public async Task<PoolHttpResult> SendAsync(PoolEndpoint endpoint, PoolRequest request, CancellationToken ct = default)
    {
        var behavior = GetBehavior(endpoint.EndpointId);

        // 模拟延迟
        if (behavior.LatencyMs > 0)
            await Task.Delay(behavior.LatencyMs, ct);

        lock (_lock)
        {
            _records.Add(new DispatchRecord
            {
                EndpointId = endpoint.EndpointId,
                ModelId = endpoint.ModelId,
                Timestamp = DateTime.UtcNow
            });
        }

        if (behavior.ThrowException != null)
            throw behavior.ThrowException;

        if (behavior.ShouldFail)
            return PoolHttpResult.Fail(behavior.ErrorMessage ?? "Mock failure", behavior.StatusCode, behavior.LatencyMs);

        return PoolHttpResult.Success(behavior.ResponseBody ?? "{}", behavior.LatencyMs);
    }

    public async IAsyncEnumerable<PoolStreamChunk> SendStreamAsync(
        PoolEndpoint endpoint,
        PoolRequest request,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var behavior = GetBehavior(endpoint.EndpointId);

        if (behavior.LatencyMs > 0)
            await Task.Delay(behavior.LatencyMs, ct);

        lock (_lock)
        {
            _records.Add(new DispatchRecord
            {
                EndpointId = endpoint.EndpointId,
                ModelId = endpoint.ModelId,
                Timestamp = DateTime.UtcNow
            });
        }

        if (behavior.ShouldFail)
        {
            yield return PoolStreamChunk.Fail(behavior.ErrorMessage ?? "Mock stream failure");
            yield break;
        }

        // 模拟流式输出
        foreach (var word in (behavior.StreamWords ?? new[] { "Hello", " World" }))
        {
            yield return PoolStreamChunk.Text(word);
        }

        yield return PoolStreamChunk.Done("stop", null);
    }

    private EndpointBehavior GetBehavior(string endpointId)
    {
        if (_behaviors.TryGetValue(endpointId, out var behavior))
            return behavior;
        if (_behaviors.TryGetValue("*", out var defaultBehavior))
            return defaultBehavior;
        return new EndpointBehavior(); // Default: success, 0ms
    }
}

public class EndpointBehavior
{
    public bool ShouldFail { get; init; }
    public string? ErrorMessage { get; init; }
    public int StatusCode { get; init; } = 500;
    public int LatencyMs { get; init; }
    public string? ResponseBody { get; init; } = "{}";
    public Exception? ThrowException { get; init; }
    public string[]? StreamWords { get; init; }
}

public class DispatchRecord
{
    public string EndpointId { get; init; } = string.Empty;
    public string ModelId { get; init; } = string.Empty;
    public DateTime Timestamp { get; init; }
}
