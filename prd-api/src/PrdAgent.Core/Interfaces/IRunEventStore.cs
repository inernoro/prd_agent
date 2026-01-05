using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 统一 Run 事件存储（用于断线续传/观察者订阅）。
/// 生产环境建议使用 Redis（高频写），测试可用内存实现。
/// </summary>
public interface IRunEventStore
{
    Task<RunMeta?> GetRunAsync(string kind, string runId, CancellationToken ct = default);
    Task SetRunAsync(string kind, RunMeta meta, TimeSpan? ttl = null, CancellationToken ct = default);

    Task<bool> TryMarkCancelRequestedAsync(string kind, string runId, CancellationToken ct = default);
    Task<bool> IsCancelRequestedAsync(string kind, string runId, CancellationToken ct = default);

    Task<long> AppendEventAsync(string kind, string runId, string eventName, object payload, TimeSpan? ttl = null, CancellationToken ct = default);
    Task<IReadOnlyList<RunEventRecord>> GetEventsAsync(string kind, string runId, long afterSeq, int limit, CancellationToken ct = default);

    Task<RunSnapshot?> GetSnapshotAsync(string kind, string runId, CancellationToken ct = default);
    Task SetSnapshotAsync(string kind, string runId, RunSnapshot snapshot, TimeSpan? ttl = null, CancellationToken ct = default);
}


