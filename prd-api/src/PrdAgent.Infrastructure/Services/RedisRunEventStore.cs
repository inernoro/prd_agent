using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using StackExchange.Redis;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// Redis Run 事件存储（高频写）：\n
/// - seq: INCR\n
/// - events: ZSET(score=seq, member=json)\n
/// - meta/snapshot: HASH\n
/// </summary>
public sealed class RedisRunEventStore : IRunEventStore, IDisposable
{
    private readonly ConnectionMultiplexer _redis;
    private readonly IDatabase _db;
    private readonly TimeSpan _defaultTtl;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public RedisRunEventStore(string connectionString, TimeSpan? defaultTtl = null)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
            throw new ArgumentException("Redis 连接字符串不能为空", nameof(connectionString));
        _redis = ConnectionMultiplexer.Connect(connectionString.Trim());
        _db = _redis.GetDatabase();
        _defaultTtl = defaultTtl ?? TimeSpan.FromHours(24);
    }

    private static string Norm(string raw) => (raw ?? string.Empty).Trim();

    private static string SeqKey(string kind, string runId) => $"run:{Norm(kind)}:{Norm(runId)}:seq";
    private static string EventsKey(string kind, string runId) => $"run:{Norm(kind)}:{Norm(runId)}:events";
    private static string MetaKey(string kind, string runId) => $"run:{Norm(kind)}:{Norm(runId)}:meta";
    private static string SnapshotKey(string kind, string runId) => $"run:{Norm(kind)}:{Norm(runId)}:snapshot";

    private static TimeSpan TtlOrDefault(TimeSpan? ttl, TimeSpan def) => ttl.HasValue && ttl.Value > TimeSpan.Zero ? ttl.Value : def;

    public async Task<RunMeta?> GetRunAsync(string kind, string runId, CancellationToken ct = default)
    {
        var k = MetaKey(kind, runId);
        var entries = await _db.HashGetAllAsync(k);
        if (entries == null || entries.Length == 0) return null;

        var map = entries.ToDictionary(x => x.Name.ToString(), x => x.Value.ToString(), StringComparer.OrdinalIgnoreCase);
        var meta = new RunMeta
        {
            RunId = Norm(runId),
            Kind = Norm(kind),
            Status = map.TryGetValue("status", out var st) ? st : RunStatuses.Queued,
            GroupId = map.TryGetValue("groupId", out var gid) ? gid : null,
            SessionId = map.TryGetValue("sessionId", out var sid) ? sid : null,
            CreatedByUserId = map.TryGetValue("createdByUserId", out var uid) ? uid : null,
            UserMessageId = map.TryGetValue("userMessageId", out var um) ? um : null,
            AssistantMessageId = map.TryGetValue("assistantMessageId", out var am) ? am : null,
            ErrorCode = map.TryGetValue("errorCode", out var ec) ? ec : null,
            ErrorMessage = map.TryGetValue("errorMessage", out var em) ? em : null,
            InputJson = map.TryGetValue("inputJson", out var ij) ? ij : null,
        };

        if (map.TryGetValue("lastSeq", out var ls) && long.TryParse(ls, out var lsv) && lsv > 0) meta.LastSeq = lsv;
        if (map.TryGetValue("cancelRequested", out var cr) && bool.TryParse(cr, out var crv)) meta.CancelRequested = crv;
        if (map.TryGetValue("createdAt", out var ca) && DateTime.TryParse(ca, out var cav)) meta.CreatedAt = DateTime.SpecifyKind(cav, DateTimeKind.Utc);
        if (map.TryGetValue("startedAt", out var sa) && DateTime.TryParse(sa, out var sav)) meta.StartedAt = DateTime.SpecifyKind(sav, DateTimeKind.Utc);
        if (map.TryGetValue("endedAt", out var ea) && DateTime.TryParse(ea, out var eav)) meta.EndedAt = DateTime.SpecifyKind(eav, DateTimeKind.Utc);

        return meta;
    }

    public async Task SetRunAsync(string kind, RunMeta meta, TimeSpan? ttl = null, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(meta);
        var runId = Norm(meta.RunId);
        if (string.IsNullOrWhiteSpace(runId)) throw new ArgumentException("runId 不能为空", nameof(meta));
        var k = MetaKey(kind, runId);
        var entries = new List<HashEntry>
        {
            new("status", meta.Status ?? RunStatuses.Queued),
            new("lastSeq", meta.LastSeq),
            new("cancelRequested", meta.CancelRequested ? "true" : "false"),
            new("createdAt", meta.CreatedAt.ToString("O")),
        };
        if (!string.IsNullOrWhiteSpace(meta.GroupId)) entries.Add(new("groupId", meta.GroupId));
        if (!string.IsNullOrWhiteSpace(meta.SessionId)) entries.Add(new("sessionId", meta.SessionId));
        if (!string.IsNullOrWhiteSpace(meta.CreatedByUserId)) entries.Add(new("createdByUserId", meta.CreatedByUserId));
        if (!string.IsNullOrWhiteSpace(meta.UserMessageId)) entries.Add(new("userMessageId", meta.UserMessageId));
        if (!string.IsNullOrWhiteSpace(meta.AssistantMessageId)) entries.Add(new("assistantMessageId", meta.AssistantMessageId));
        if (meta.StartedAt.HasValue) entries.Add(new("startedAt", meta.StartedAt.Value.ToString("O")));
        if (meta.EndedAt.HasValue) entries.Add(new("endedAt", meta.EndedAt.Value.ToString("O")));
        if (!string.IsNullOrWhiteSpace(meta.ErrorCode)) entries.Add(new("errorCode", meta.ErrorCode));
        if (!string.IsNullOrWhiteSpace(meta.ErrorMessage)) entries.Add(new("errorMessage", meta.ErrorMessage));
        if (!string.IsNullOrWhiteSpace(meta.InputJson)) entries.Add(new("inputJson", meta.InputJson));

        await _db.HashSetAsync(k, entries.ToArray());
        var t = TtlOrDefault(ttl, _defaultTtl);
        await _db.KeyExpireAsync(k, t);
    }

    public async Task<bool> TryMarkCancelRequestedAsync(string kind, string runId, CancellationToken ct = default)
    {
        var k = MetaKey(kind, runId);
        // 非原子：足够；worker/stream 会轮询
        await _db.HashSetAsync(k, new[] { new HashEntry("cancelRequested", "true") });
        return true;
    }

    public async Task<bool> IsCancelRequestedAsync(string kind, string runId, CancellationToken ct = default)
    {
        var k = MetaKey(kind, runId);
        var v = await _db.HashGetAsync(k, "cancelRequested");
        return !v.IsNullOrEmpty && string.Equals(v.ToString(), "true", StringComparison.OrdinalIgnoreCase);
    }

    public async Task<long> AppendEventAsync(string kind, string runId, string eventName, object payload, TimeSpan? ttl = null, CancellationToken ct = default)
    {
        var rid = Norm(runId);
        if (string.IsNullOrWhiteSpace(rid)) throw new ArgumentException("runId 不能为空", nameof(runId));

        var seqKey = SeqKey(kind, rid);
        var evKey = EventsKey(kind, rid);
        var metaKey = MetaKey(kind, rid);

        var seq = (long)await _db.StringIncrementAsync(seqKey, 1);
        if (seq <= 0) seq = 1;

        var record = new RunEventRecord
        {
            RunId = rid,
            Seq = seq,
            EventName = (eventName ?? string.Empty).Trim(),
            PayloadJson = JsonSerializer.Serialize(payload ?? new { }, JsonOptions),
            CreatedAt = DateTime.UtcNow
        };
        var member = JsonSerializer.Serialize(record, JsonOptions);

        await _db.SortedSetAddAsync(evKey, member, seq);

        // 更新 meta.lastSeq（Redis Hash）
        await _db.HashSetAsync(metaKey, new[] { new HashEntry("lastSeq", seq) });

        var t = TtlOrDefault(ttl, _defaultTtl);
        await _db.KeyExpireAsync(seqKey, t);
        await _db.KeyExpireAsync(evKey, t);
        await _db.KeyExpireAsync(metaKey, t);

        return seq;
    }

    public async Task<IReadOnlyList<RunEventRecord>> GetEventsAsync(string kind, string runId, long afterSeq, int limit, CancellationToken ct = default)
    {
        var take = Math.Clamp(limit, 1, 500);
        var evKey = EventsKey(kind, runId);
        var min = afterSeq <= 0 ? 1 : afterSeq + 1;

        var values = await _db.SortedSetRangeByScoreAsync(evKey, start: min, stop: double.PositiveInfinity, exclude: Exclude.None, order: Order.Ascending, skip: 0, take: take);
        if (values == null || values.Length == 0) return Array.Empty<RunEventRecord>();

        var list = new List<RunEventRecord>(values.Length);
        foreach (var v in values)
        {
            if (v.IsNullOrEmpty) continue;
            try
            {
                var rec = JsonSerializer.Deserialize<RunEventRecord>(v!, JsonOptions);
                if (rec != null) list.Add(rec);
            }
            catch
            {
                // ignore bad record
            }
        }
        return list;
    }

    public async Task<RunSnapshot?> GetSnapshotAsync(string kind, string runId, CancellationToken ct = default)
    {
        var k = SnapshotKey(kind, runId);
        var seqRaw = await _db.HashGetAsync(k, "seq");
        var json = await _db.HashGetAsync(k, "json");
        if (seqRaw.IsNullOrEmpty || json.IsNullOrEmpty) return null;
        if (!long.TryParse(seqRaw.ToString(), out var seq) || seq <= 0) return null;
        return new RunSnapshot
        {
            Seq = seq,
            SnapshotJson = json.ToString(),
            UpdatedAt = DateTime.UtcNow
        };
    }

    public async Task SetSnapshotAsync(string kind, string runId, RunSnapshot snapshot, TimeSpan? ttl = null, CancellationToken ct = default)
    {
        var k = SnapshotKey(kind, runId);
        var t = TtlOrDefault(ttl, _defaultTtl);
        await _db.HashSetAsync(k, new[]
        {
            new HashEntry("seq", snapshot.Seq),
            new HashEntry("json", snapshot.SnapshotJson ?? "{}"),
            new HashEntry("updatedAt", snapshot.UpdatedAt.ToString("O")),
        });
        await _db.KeyExpireAsync(k, t);
    }

    public void Dispose()
    {
        _redis.Dispose();
    }
}


