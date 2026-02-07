using System.Collections.Concurrent;
using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// 内存健康追踪器实现
/// 线程安全，支持并发读写
/// </summary>
public class PoolHealthTracker : IPoolHealthTracker
{
    private readonly ConcurrentDictionary<string, EndpointHealth> _health = new();

    /// <summary>降级阈值：连续失败 N 次后降级</summary>
    public int DegradeThreshold { get; init; } = 3;

    /// <summary>不可用阈值：连续失败 N 次后标记不可用</summary>
    public int UnavailableThreshold { get; init; } = 5;

    /// <summary>延迟滑动窗口大小</summary>
    public int LatencyWindowSize { get; init; } = 20;

    public void RecordSuccess(string endpointId, long latencyMs)
    {
        var health = _health.GetOrAdd(endpointId, _ => new EndpointHealth());
        lock (health)
        {
            health.ConsecutiveSuccesses++;
            health.ConsecutiveFailures = 0;
            health.Status = EndpointHealthStatus.Healthy;
            health.LastSuccessAt = DateTime.UtcNow;
            health.AddLatency(latencyMs, LatencyWindowSize);
        }
    }

    public void RecordFailure(string endpointId)
    {
        var health = _health.GetOrAdd(endpointId, _ => new EndpointHealth());
        lock (health)
        {
            health.ConsecutiveFailures++;
            health.ConsecutiveSuccesses = 0;
            health.LastFailedAt = DateTime.UtcNow;

            health.Status = health.ConsecutiveFailures >= UnavailableThreshold
                ? EndpointHealthStatus.Unavailable
                : health.ConsecutiveFailures >= DegradeThreshold
                    ? EndpointHealthStatus.Degraded
                    : EndpointHealthStatus.Healthy;
        }
    }

    public EndpointHealthStatus GetStatus(string endpointId)
    {
        return _health.TryGetValue(endpointId, out var health)
            ? health.Status
            : EndpointHealthStatus.Healthy;
    }

    public double GetAverageLatencyMs(string endpointId)
    {
        if (!_health.TryGetValue(endpointId, out var health))
            return 0;

        lock (health)
        {
            return health.LatencyWindow.Count > 0
                ? health.LatencyWindow.Average()
                : 0;
        }
    }

    public int GetConsecutiveFailures(string endpointId)
    {
        return _health.TryGetValue(endpointId, out var health)
            ? health.ConsecutiveFailures
            : 0;
    }

    public int GetHealthScore(string endpointId)
    {
        if (!_health.TryGetValue(endpointId, out var health))
            return 100;

        return health.Status switch
        {
            EndpointHealthStatus.Healthy => 100 - Math.Min(health.ConsecutiveFailures * 5, 20),
            EndpointHealthStatus.Degraded => 50 - Math.Min(health.ConsecutiveFailures * 10, 40),
            EndpointHealthStatus.Unavailable => 0,
            _ => 50
        };
    }

    public PoolHealthSnapshot GetSnapshot(IReadOnlyList<PoolEndpoint> endpoints)
    {
        return new PoolHealthSnapshot
        {
            Endpoints = endpoints.Select(ep =>
            {
                var endpointId = ep.EndpointId;
                _health.TryGetValue(endpointId, out var health);

                return new EndpointHealthInfo
                {
                    EndpointId = endpointId,
                    ModelId = ep.ModelId,
                    Status = health?.Status ?? EndpointHealthStatus.Healthy,
                    ConsecutiveFailures = health?.ConsecutiveFailures ?? 0,
                    ConsecutiveSuccesses = health?.ConsecutiveSuccesses ?? 0,
                    LastSuccessAt = health?.LastSuccessAt,
                    LastFailedAt = health?.LastFailedAt,
                    AverageLatencyMs = health != null && health.LatencyWindow.Count > 0
                        ? health.LatencyWindow.Average()
                        : null,
                    HealthScore = GetHealthScore(endpointId)
                };
            }).ToList()
        };
    }

    public void ResetHealth(string endpointId)
    {
        if (_health.TryGetValue(endpointId, out var health))
        {
            lock (health)
            {
                health.Status = EndpointHealthStatus.Healthy;
                health.ConsecutiveFailures = 0;
                health.ConsecutiveSuccesses = 0;
                health.LastSuccessAt = DateTime.UtcNow;
            }
        }
    }

    public void ResetAll()
    {
        foreach (var kvp in _health)
        {
            lock (kvp.Value)
            {
                kvp.Value.Status = EndpointHealthStatus.Healthy;
                kvp.Value.ConsecutiveFailures = 0;
                kvp.Value.ConsecutiveSuccesses = 0;
                kvp.Value.LastSuccessAt = DateTime.UtcNow;
            }
        }
    }

    public bool IsAvailable(string endpointId)
    {
        return GetStatus(endpointId) != EndpointHealthStatus.Unavailable;
    }

    /// <summary>
    /// 内部健康状态跟踪
    /// </summary>
    private class EndpointHealth
    {
        public EndpointHealthStatus Status = EndpointHealthStatus.Healthy;
        public int ConsecutiveFailures;
        public int ConsecutiveSuccesses;
        public DateTime? LastSuccessAt;
        public DateTime? LastFailedAt;
        public readonly Queue<long> LatencyWindow = new();

        public void AddLatency(long latencyMs, int windowSize)
        {
            LatencyWindow.Enqueue(latencyMs);
            while (LatencyWindow.Count > windowSize)
                LatencyWindow.Dequeue();
        }
    }
}
