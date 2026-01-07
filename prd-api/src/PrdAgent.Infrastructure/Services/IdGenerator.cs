using PrdAgent.Core.Interfaces;
using StackExchange.Redis;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// ID生成器实现
/// - 开发/测试环境: 使用 Redis 自增序列生成可读ID（user1, group1, platform1, ...）
/// - 生产环境: 使用 GUID
/// </summary>
public class IdGenerator : IIdGenerator
{
    private readonly IDatabase _redis;
    private readonly bool _useReadableIds;
    private const string KeyPrefix = "prd_agent:id_seq:";

    // 已废弃：所有类别统一从 1 开始，直接 INCR 即可
    // private static readonly Dictionary<string, int> CategoryStartIndex = ...

    public IdGenerator(IConnectionMultiplexer redis, bool useReadableIds)
    {
        _redis = redis.GetDatabase();
        _useReadableIds = useReadableIds;
    }

    // 兼容历史调用方（DI 里多数仍注入 ConnectionMultiplexer）
    public IdGenerator(ConnectionMultiplexer redis, bool useReadableIds)
        : this((IConnectionMultiplexer)redis, useReadableIds)
    {
    }

    public async Task<string> GenerateIdAsync(string category)
    {
        if (!_useReadableIds)
        {
            return Guid.NewGuid().ToString("N");
        }

        var key = $"{KeyPrefix}{category}";
        var seq = await _redis.StringIncrementAsync(key);
        
        return $"{category}{seq}";
    }
}

