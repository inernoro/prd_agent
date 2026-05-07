using System.Collections.Concurrent;

namespace PrdAgent.Infrastructure.Services.ClaudeSidecar;

/// <summary>
/// 线程安全的 sidecar 实例健康状态注册表，由 HealthChecker 写入、Router 读取。
/// 单例 DI。
/// </summary>
public sealed class InstanceStateRegistry
{
    private readonly ConcurrentDictionary<string, InstanceHealth> _state = new();
    private long _roundRobinCounter;

    public void RecordSuccess(string name)
    {
        _state.AddOrUpdate(name,
            _ => new InstanceHealth { Healthy = true, ConsecutiveFailures = 0, LastChecked = DateTime.UtcNow },
            (_, h) => { h.Healthy = true; h.ConsecutiveFailures = 0; h.LastChecked = DateTime.UtcNow; return h; });
    }

    public void RecordFailure(string name, int unhealthyThreshold = 3)
    {
        _state.AddOrUpdate(name,
            _ => new InstanceHealth { Healthy = false, ConsecutiveFailures = 1, LastChecked = DateTime.UtcNow },
            (_, h) =>
            {
                h.ConsecutiveFailures++;
                h.LastChecked = DateTime.UtcNow;
                if (h.ConsecutiveFailures >= unhealthyThreshold) h.Healthy = false;
                return h;
            });
    }

    public bool IsHealthy(string name) =>
        _state.TryGetValue(name, out var h) && h.Healthy;

    public bool IsKnownUnhealthy(string name) =>
        _state.TryGetValue(name, out var h) && !h.Healthy;

    public int CountHealthy() => _state.Count(kv => kv.Value.Healthy);

    public IEnumerable<(string Name, InstanceHealth Health)> Snapshot() =>
        _state.Select(kv => (kv.Key, kv.Value));

    public int NextRoundRobin(int modulus)
    {
        if (modulus <= 0) return 0;
        var v = Interlocked.Increment(ref _roundRobinCounter);
        return (int)((v - 1) % modulus);
    }
}

public sealed class InstanceHealth
{
    public bool Healthy { get; set; }
    public int ConsecutiveFailures { get; set; }
    public DateTime LastChecked { get; set; }
}
