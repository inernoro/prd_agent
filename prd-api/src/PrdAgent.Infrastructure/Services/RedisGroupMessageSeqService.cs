using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using MongoDB.Driver;
using StackExchange.Redis;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 群消息顺序号生成（Redis 原子自增）。
/// - 单号：INCR 1
/// - 成对号：INCRBY 2，一次性拿到 (first, second)（历史兼容；新业务不再依赖奇偶规则）。
/// </summary>
public sealed class RedisGroupMessageSeqService : IGroupMessageSeqService, IDisposable
{
    private readonly ConnectionMultiplexer _redis;
    private readonly IDatabase _db;
    private readonly IMongoCollection<Message> _messages;

    public RedisGroupMessageSeqService(string connectionString, IMongoCollection<Message> messages)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
            throw new ArgumentException("Redis 连接字符串不能为空", nameof(connectionString));

        _messages = messages ?? throw new ArgumentNullException(nameof(messages));
        _redis = ConnectionMultiplexer.Connect(connectionString.Trim());
        _db = _redis.GetDatabase();
    }

    private static string SeqKey(string groupId)
    {
        var gid = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid))
            throw new ArgumentException("groupId 不能为空", nameof(groupId));
        return $"group:seq:{gid}";
    }

    public async Task<long> NextAsync(string groupId, CancellationToken cancellationToken = default)
    {
        // StackExchange.Redis 不支持 CancellationToken；这里保持签名一致即可。
        var key = SeqKey(groupId);
        await EnsureRedisAlignedAsync(groupId);
        var v = await _db.StringIncrementAsync(key, 1);
        return v <= 0 ? 1 : (long)v;
    }

    private async Task<long> GetMongoMaxSeqAsync(string groupId)
    {
        var gid = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid)) return 0;

        var fb = Builders<Message>.Filter;
        var filter = fb.Eq(x => x.GroupId, gid) & fb.Ne(x => x.GroupSeq, null);

        var doc = await _messages
            .Find(filter)
            .SortByDescending(x => x.GroupSeq)
            .Limit(1)
            .FirstOrDefaultAsync();

        var v = doc?.GroupSeq ?? 0;
        return v > 0 ? v : 0;
    }

    private async Task EnsureRedisAlignedAsync(string groupId)
    {
        // 目的：避免历史数据已有 groupSeq（Mongo 唯一索引），但 Redis key 从 0 开始导致 seq 冲突。
        // 策略：取 Mongo 最大 seq，将 Redis key 至少对齐到该值（允许跳号，但绝不回退）。
        var key = SeqKey(groupId);

        // 读 Redis 当前值（可能不存在）
        var raw = await _db.StringGetAsync(key);
        long current = 0;
        if (!raw.IsNullOrEmpty && long.TryParse(raw.ToString(), out var parsed) && parsed > 0)
        {
            current = parsed;
        }

        var mongoMax = await GetMongoMaxSeqAsync(groupId);
        if (mongoMax <= 0) return;

        var target = mongoMax;

        if (current <= 0)
        {
            // key 不存在/不可解析：用 NX 初始化
            _ = await _db.StringSetAsync(key, target, when: When.NotExists);
            return;
        }

        if (current < target)
        {
            // key 存在但落后：直接抬高到 target（允许跳号，但绝不回退）
            _ = await _db.StringSetAsync(key, target);
        }
    }

    public async Task<(long UserSeq, long AssistantSeq)> AllocatePairAsync(
        string groupId,
        CancellationToken cancellationToken = default)
    {
        var key = SeqKey(groupId);
        await EnsureRedisAlignedAsync(groupId);
        var v = await _db.StringIncrementAsync(key, 2);
        var second = (long)v;
        var first = second - 1;
        if (first <= 0) first = 1;
        if (second <= first) second = first + 1;
        return (first, second);
    }

    public void Dispose()
    {
        _redis.Dispose();
    }
}


