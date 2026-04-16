using System.Collections.Concurrent;
using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// 内存健康追踪器实现
/// 线程安全，支持并发读写
///
/// Half-Open 熔断器设计（无后台探针）：
/// 当端点进入 Unavailable 状态后，不依赖后台探活任务恢复。
/// 而是在 IsAvailable() 中：若距上次失败已超过 HalfOpenCooldownSeconds，
/// 则放行下一个真实用户请求作为探针。请求成功 → RecordSuccess → 恢复 Healthy；
/// 请求失败 → RecordFailure → 重置冷却计时，再等一轮。
/// 优点：多实例安全（各实例独立尝试）、零后台线程、不消耗额外配额。
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

    /// <summary>
    /// Half-Open 冷却时间（秒）。
    /// Unavailable 端点在距上次失败超过此时间后，允许下一个真实请求通过以探测恢复。
    /// 默认 300 秒（5 分钟）。设为 0 则禁用 Half-Open（端点一旦 Unavailable 需手动重置）。
    /// </summary>
    public int HalfOpenCooldownSeconds { get; init; } = 300;

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

    /// <summary>
    /// 判断端点是否可接受请求。
    /// Healthy / Degraded → 始终可用。
    /// Unavailable → 正常拒绝；但若距上次失败已超过 HalfOpenCooldownSeconds，
    ///               放行本次请求（Half-Open 探针），由真实结果决定是否恢复。
    /// </summary>
    public bool IsAvailable(string endpointId)
    {
        if (!_health.TryGetValue(endpointId, out var health))
            return true; // 未知端点默认健康

        if (health.Status != EndpointHealthStatus.Unavailable)
            return true;

        // Half-Open：冷却时间到则放行一次真实请求作为探针
        if (HalfOpenCooldownSeconds > 0
            && health.LastFailedAt.HasValue
            && (DateTime.UtcNow - health.LastFailedAt.Value).TotalSeconds >= HalfOpenCooldownSeconds)
        {
            return true;
        }

        return false;
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
