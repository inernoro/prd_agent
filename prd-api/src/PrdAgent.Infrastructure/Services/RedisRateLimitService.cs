using System.Text.Json;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using StackExchange.Redis;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 基于 Redis 的分布式限流服务
/// </summary>
public class RedisRateLimitService : IRateLimitService
{
    private readonly IDatabase _db;
    private readonly ILogger<RedisRateLimitService> _logger;

    // Redis Key 前缀
    private const string KeyPrefix = "ratelimit:";
    private const string RequestCountKey = KeyPrefix + "count:";      // 滑动窗口请求计数
    private const string ConcurrentKey = KeyPrefix + "concurrent:";   // 并发计数
    private const string ExemptKey = KeyPrefix + "exempt:";           // 豁免用户集合
    private const string UserConfigKey = KeyPrefix + "userconfig:";   // 用户自定义配置
    private const string GlobalConfigKey = KeyPrefix + "global";      // 全局配置

    // 滑动窗口时间（秒）
    private const int WindowSeconds = 60;

    public RedisRateLimitService(ConnectionMultiplexer redis, ILogger<RedisRateLimitService> logger)
    {
        _db = redis.GetDatabase();
        _logger = logger;
    }

    public async Task<(bool allowed, string? reason)> CheckRequestAsync(string clientId, CancellationToken ct = default)
    {
        // 获取配置
        var config = await GetEffectiveConfigAsync(clientId, ct);

        var countKey = RequestCountKey + clientId;
        var concurrentKey = ConcurrentKey + clientId;
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var windowStart = now - WindowSeconds;

        // 使用 Lua 脚本原子执行滑动窗口限流
        var script = @"
            -- 清理过期记录
            redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])

            -- 获取当前请求数
            local count = redis.call('ZCARD', KEYS[1])

            -- 获取当前并发数
            local concurrent = tonumber(redis.call('GET', KEYS[2]) or '0')

            -- 检查频率限制
            if count >= tonumber(ARGV[2]) then
                return {0, 'rate'}
            end

            -- 检查并发限制
            if concurrent >= tonumber(ARGV[3]) then
                return {0, 'concurrent'}
            end

            -- 记录请求（使用时间戳作为 score，唯一 ID 作为 member）
            redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
            redis.call('EXPIRE', KEYS[1], ARGV[6])

            -- 增加并发计数
            redis.call('INCR', KEYS[2])
            redis.call('EXPIRE', KEYS[2], ARGV[7])

            return {1, 'ok'}
        ";

        var uniqueId = $"{now}:{Guid.NewGuid():N}";
        var result = await _db.ScriptEvaluateAsync(
            script,
            new RedisKey[] { countKey, concurrentKey },
            new RedisValue[]
            {
                windowStart,
                config.MaxRequestsPerMinute,
                config.MaxConcurrentRequests,
                now,
                uniqueId,
                WindowSeconds + 10, // 请求计数 TTL
                300                  // 并发计数 TTL（5 分钟，防止异常未释放）
            });

        var arr = (RedisResult[])result!;
        var allowed = (int)arr[0] == 1;
        var reason = (string?)arr[1];

        if (!allowed)
        {
            return reason switch
            {
                "rate" => (false, "请求频率过高，请稍后再试"),
                "concurrent" => (false, "并发请求过多，请稍后再试"),
                _ => (false, "请求被限制")
            };
        }

        return (true, null);
    }

    public async Task RequestCompletedAsync(string clientId, CancellationToken ct = default)
    {
        var concurrentKey = ConcurrentKey + clientId;
        var current = await _db.StringDecrementAsync(concurrentKey);

        // 防止计数变为负数
        if (current < 0)
        {
            await _db.StringSetAsync(concurrentKey, 0);
        }
    }

    public async Task<bool> IsExemptAsync(string userId, CancellationToken ct = default)
    {
        return await _db.SetContainsAsync(ExemptKey + "set", userId);
    }

    public async Task SetExemptAsync(string userId, bool exempt, CancellationToken ct = default)
    {
        if (exempt)
        {
            await _db.SetAddAsync(ExemptKey + "set", userId);
            _logger.LogInformation("User {UserId} added to rate limit exempt list", userId);
        }
        else
        {
            await _db.SetRemoveAsync(ExemptKey + "set", userId);
            _logger.LogInformation("User {UserId} removed from rate limit exempt list", userId);
        }
    }

    public async Task<UserRateLimitConfig?> GetUserConfigAsync(string userId, CancellationToken ct = default)
    {
        var json = await _db.StringGetAsync(UserConfigKey + userId);
        if (json.IsNullOrEmpty)
            return null;

        return JsonSerializer.Deserialize<UserRateLimitConfig>(json!);
    }

    public async Task SetUserConfigAsync(string userId, UserRateLimitConfig config, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(config);
        await _db.StringSetAsync(UserConfigKey + userId, json);
        _logger.LogInformation("User {UserId} rate limit config updated: {Config}", userId, json);
    }

    public async Task RemoveUserConfigAsync(string userId, CancellationToken ct = default)
    {
        await _db.KeyDeleteAsync(UserConfigKey + userId);
        _logger.LogInformation("User {UserId} rate limit config removed", userId);
    }

    public async Task<GlobalRateLimitConfig> GetGlobalConfigAsync(CancellationToken ct = default)
    {
        var json = await _db.StringGetAsync(GlobalConfigKey);
        if (json.IsNullOrEmpty)
        {
            // 返回默认配置
            return new GlobalRateLimitConfig
            {
                MaxRequestsPerMinute = 600,
                MaxConcurrentRequests = 100
            };
        }

        return JsonSerializer.Deserialize<GlobalRateLimitConfig>(json!) ?? new GlobalRateLimitConfig();
    }

    public async Task SetGlobalConfigAsync(GlobalRateLimitConfig config, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(config);
        await _db.StringSetAsync(GlobalConfigKey, json);
        _logger.LogInformation("Global rate limit config updated: {Config}", json);
    }

    public async Task<IReadOnlyList<string>> GetAllExemptUsersAsync(CancellationToken ct = default)
    {
        var members = await _db.SetMembersAsync(ExemptKey + "set");
        return members.Select(m => m.ToString()).ToList();
    }

    public async Task<IReadOnlyList<(string userId, UserRateLimitConfig config)>> GetAllUserConfigsAsync(CancellationToken ct = default)
    {
        var server = _db.Multiplexer.GetServer(_db.Multiplexer.GetEndPoints()[0]);
        var keys = server.Keys(pattern: UserConfigKey + "*").ToArray();

        var result = new List<(string, UserRateLimitConfig)>();
        foreach (var key in keys)
        {
            var userId = key.ToString().Replace(UserConfigKey, "");
            var json = await _db.StringGetAsync(key);
            if (!json.IsNullOrEmpty)
            {
                var config = JsonSerializer.Deserialize<UserRateLimitConfig>(json!);
                if (config != null)
                {
                    result.Add((userId, config));
                }
            }
        }

        return result;
    }

    /// <summary>
    /// 获取客户端的有效限流配置
    /// </summary>
    private async Task<UserRateLimitConfig> GetEffectiveConfigAsync(string clientId, CancellationToken ct)
    {
        // 如果是用户 ID，检查用户自定义配置
        if (clientId.StartsWith("user:"))
        {
            var userId = clientId["user:".Length..];
            var userConfig = await GetUserConfigAsync(userId, ct);
            if (userConfig != null)
            {
                return userConfig;
            }
        }

        // 返回全局配置
        var globalConfig = await GetGlobalConfigAsync(ct);
        return new UserRateLimitConfig
        {
            MaxRequestsPerMinute = globalConfig.MaxRequestsPerMinute,
            MaxConcurrentRequests = globalConfig.MaxConcurrentRequests
        };
    }
}
