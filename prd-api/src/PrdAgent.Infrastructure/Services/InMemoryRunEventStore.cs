using System.Collections.Concurrent;
using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 内存 Run 事件存储（用于单测/本地开发）：不依赖 Redis/DB/LLM。
/// </summary>
public sealed class InMemoryRunEventStore : IRunEventStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly ConcurrentDictionary<string, RunMeta> _meta = new();
    private readonly ConcurrentDictionary<string, long> _seq = new();
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<long, RunEventRecord>> _events = new();
    private readonly ConcurrentDictionary<string, RunSnapshot> _snapshots = new();

    private static string Key(string kind, string runId) => $"{(kind ?? string.Empty).Trim()}::{(runId ?? string.Empty).Trim()}";

    public Task<RunMeta?> GetRunAsync(string kind, string runId, CancellationToken ct = default)
    {
        _meta.TryGetValue(Key(kind, runId), out var meta);
        return Task.FromResult(meta);
    }

    public Task SetRunAsync(string kind, RunMeta meta, TimeSpan? ttl = null, CancellationToken ct = default)
    {
        _meta[Key(kind, meta.RunId)] = meta;
        return Task.CompletedTask;
    }

    public Task<bool> TryMarkCancelRequestedAsync(string kind, string runId, CancellationToken ct = default)
    {
        var k = Key(kind, runId);
        _meta.AddOrUpdate(k, _ => new RunMeta { RunId = runId, Kind = kind, CancelRequested = true }, (_, m) =>
        {
            m.CancelRequested = true;
            return m;
        });
        return Task.FromResult(true);
    }

    public Task<bool> IsCancelRequestedAsync(string kind, string runId, CancellationToken ct = default)
    {
        var k = Key(kind, runId);
        return Task.FromResult(_meta.TryGetValue(k, out var m) && m.CancelRequested);
    }

    public Task<long> AppendEventAsync(string kind, string runId, string eventName, object payload, TimeSpan? ttl = null, CancellationToken ct = default)
    {
        var k = Key(kind, runId);
        var seq = _seq.AddOrUpdate(k, 1, (_, v) => v + 1);

        var rec = new RunEventRecord
        {
            RunId = runId,
            Seq = seq,
            EventName = (eventName ?? string.Empty).Trim(),
            PayloadJson = JsonSerializer.Serialize(payload ?? new { }, JsonOptions),
            CreatedAt = DateTime.UtcNow
        };
        var map = _events.GetOrAdd(k, _ => new ConcurrentDictionary<long, RunEventRecord>());
        map[seq] = rec;

        _meta.AddOrUpdate(k, _ => new RunMeta { RunId = runId, Kind = kind, LastSeq = seq }, (_, m) =>
        {
            m.LastSeq = Math.Max(m.LastSeq, seq);
            return m;
        });

        return Task.FromResult(seq);
    }

    public Task<IReadOnlyList<RunEventRecord>> GetEventsAsync(string kind, string runId, long afterSeq, int limit, CancellationToken ct = default)
    {
        var k = Key(kind, runId);
        if (!_events.TryGetValue(k, out var map) || map.IsEmpty) return Task.FromResult<IReadOnlyList<RunEventRecord>>(Array.Empty<RunEventRecord>());
        var take = Math.Clamp(limit, 1, 500);
        var min = afterSeq <= 0 ? 1 : afterSeq + 1;

        var list = map
            .Where(kv => kv.Key >= min)
            .OrderBy(kv => kv.Key)
            .Take(take)
            .Select(kv => kv.Value)
            .ToList();
        return Task.FromResult<IReadOnlyList<RunEventRecord>>(list);
    }

    public Task<RunSnapshot?> GetSnapshotAsync(string kind, string runId, CancellationToken ct = default)
    {
        _snapshots.TryGetValue(Key(kind, runId), out var s);
        return Task.FromResult(s);
    }

    public Task SetSnapshotAsync(string kind, string runId, RunSnapshot snapshot, TimeSpan? ttl = null, CancellationToken ct = default)
    {
        _snapshots[Key(kind, runId)] = snapshot;
        return Task.CompletedTask;
    }
}


