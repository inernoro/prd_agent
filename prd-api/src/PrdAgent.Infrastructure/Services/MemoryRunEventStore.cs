using System.Collections.Concurrent;
using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 内存 Run 事件存储 - Redis 不可用时的 fallback
/// 注意：仅用于开发环境，不支持分布式场景
/// </summary>
public class MemoryRunEventStore : IRunEventStore
{
    private readonly ConcurrentDictionary<string, RunMeta> _runs = new();
    private readonly ConcurrentDictionary<string, List<RunEventRecord>> _events = new();
    private readonly ConcurrentDictionary<string, RunSnapshot> _snapshots = new();
    private readonly ConcurrentDictionary<string, bool> _cancelRequests = new();

    private static string MakeKey(string kind, string runId) => $"{kind}:{runId}";

    public Task<RunMeta?> GetRunAsync(string kind, string runId, CancellationToken ct = default)
    {
        var key = MakeKey(kind, runId);
        return Task.FromResult(_runs.TryGetValue(key, out var meta) ? meta : null);
    }

    public Task SetRunAsync(string kind, RunMeta meta, TimeSpan? ttl = null, CancellationToken ct = default)
    {
        var key = MakeKey(kind, meta.RunId);
        _runs[key] = meta;
        return Task.CompletedTask;
    }

    public Task<bool> TryMarkCancelRequestedAsync(string kind, string runId, CancellationToken ct = default)
    {
        var key = MakeKey(kind, runId);
        if (_runs.TryGetValue(key, out var meta))
        {
            meta.CancelRequested = true;
            _cancelRequests[key] = true;
            return Task.FromResult(true);
        }
        return Task.FromResult(false);
    }

    public Task<bool> IsCancelRequestedAsync(string kind, string runId, CancellationToken ct = default)
    {
        var key = MakeKey(kind, runId);
        return Task.FromResult(_cancelRequests.TryGetValue(key, out var val) && val);
    }

    public Task<long> AppendEventAsync(string kind, string runId, string eventName, object payload, TimeSpan? ttl = null, CancellationToken ct = default)
    {
        var key = MakeKey(kind, runId);
        var events = _events.GetOrAdd(key, _ => new List<RunEventRecord>());

        long seq;
        lock (events)
        {
            seq = events.Count + 1;
            events.Add(new RunEventRecord
            {
                RunId = runId,
                Seq = seq,
                EventName = eventName,
                PayloadJson = JsonSerializer.Serialize(payload),
                CreatedAt = DateTime.UtcNow
            });
        }

        // Update meta's LastSeq
        if (_runs.TryGetValue(key, out var meta))
        {
            meta.LastSeq = seq;
        }

        return Task.FromResult(seq);
    }

    public Task<IReadOnlyList<RunEventRecord>> GetEventsAsync(string kind, string runId, long afterSeq, int limit, CancellationToken ct = default)
    {
        var key = MakeKey(kind, runId);
        if (!_events.TryGetValue(key, out var events))
        {
            return Task.FromResult<IReadOnlyList<RunEventRecord>>(Array.Empty<RunEventRecord>());
        }

        lock (events)
        {
            var result = events
                .Where(e => e.Seq > afterSeq)
                .Take(limit)
                .ToList();
            return Task.FromResult<IReadOnlyList<RunEventRecord>>(result);
        }
    }

    public Task<RunSnapshot?> GetSnapshotAsync(string kind, string runId, CancellationToken ct = default)
    {
        var key = MakeKey(kind, runId);
        return Task.FromResult(_snapshots.TryGetValue(key, out var snapshot) ? snapshot : null);
    }

    public Task SetSnapshotAsync(string kind, string runId, RunSnapshot snapshot, TimeSpan? ttl = null, CancellationToken ct = default)
    {
        var key = MakeKey(kind, runId);
        _snapshots[key] = snapshot;
        return Task.CompletedTask;
    }
}
