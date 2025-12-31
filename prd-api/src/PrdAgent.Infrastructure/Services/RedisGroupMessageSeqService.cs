using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using MongoDB.Driver;
using StackExchange.Redis;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 群消息顺序号生成（Redis 原子自增）。
/// - 单号：INCR 1
/// - 成对号：INCRBY 2，一次性拿到 (odd, even) 以满足“User 奇数 / Assistant 偶数”。
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
        // 策略：取 Mongo 最大 seq，将 Redis key 至少对齐到该值，并对齐到“偶数边界”（assistant 为偶数）。
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

        // 对齐到偶数边界：让下一次 INCRBY 2 的返回值为偶数，从而 (odd, even) 成对成立
        var target = (mongoMax & 1) == 1 ? (mongoMax + 1) : mongoMax;

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
        else if ((current & 1) == 1)
        {
            // key 存在但为奇数：抬到偶数边界，避免后续 INCRBY 2 返回奇数
            _ = await _db.StringSetAsync(key, current + 1);
        }
    }

    public async Task<(long UserSeq, long AssistantSeq)> AllocatePairAsync(
        string groupId,
        CancellationToken cancellationToken = default)
    {
        var key = SeqKey(groupId);
        await EnsureRedisAlignedAsync(groupId);
        var v = await _db.StringIncrementAsync(key, 2);
        var even = (long)v;
        var odd = even - 1;

        // 防御：理论上 INCRBY 2 从 0 起一定得到偶数；若 Redis key 被人为写入了奇数，做一次对齐。
        if ((even & 1) == 1)
        {
            // 再进 1，使其回到偶数边界；这会“跳过”一个序号，但可保证后续严格奇偶。
            var vv = await _db.StringIncrementAsync(key, 1);
            even = (long)vv;
            odd = even - 1;
        }

        if (odd <= 0) odd = 1;
        if (even <= odd) even = odd + 1;
        // 约束：odd 必须奇数，even 必须偶数
        if ((odd & 1) == 0) odd -= 1;
        if ((even & 1) == 1) even += 1;
        if (even != odd + 1) even = odd + 1;

        return (odd, even);
    }

    public void Dispose()
    {
        _redis.Dispose();
    }
}


