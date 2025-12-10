using System.Text.Json;
using PrdAgent.Core.Interfaces;
using StackExchange.Redis;

namespace PrdAgent.Infrastructure.Cache;

/// <summary>
/// Redis缓存管理器
/// </summary>
public class RedisCacheManager : ICacheManager, IDisposable
{
    private readonly ConnectionMultiplexer _redis;
    private readonly IDatabase _db;
    private readonly TimeSpan _defaultExpiry;

    public RedisCacheManager(string connectionString, int defaultExpiryMinutes = 30)
    {
        _redis = ConnectionMultiplexer.Connect(connectionString);
        _db = _redis.GetDatabase();
        _defaultExpiry = TimeSpan.FromMinutes(defaultExpiryMinutes);
    }

    /// <summary>获取缓存</summary>
    public async Task<T?> GetAsync<T>(string key)
    {
        var value = await _db.StringGetAsync(key);
        if (value.IsNullOrEmpty)
            return default;
        
        return JsonSerializer.Deserialize<T>(value!);
    }

    /// <summary>设置缓存</summary>
    public async Task SetAsync<T>(string key, T value, TimeSpan? expiry = null)
    {
        var json = JsonSerializer.Serialize(value);
        await _db.StringSetAsync(key, json, expiry ?? _defaultExpiry);
    }

    /// <summary>删除缓存</summary>
    public async Task RemoveAsync(string key)
    {
        await _db.KeyDeleteAsync(key);
    }

    /// <summary>检查键是否存在</summary>
    public async Task<bool> ExistsAsync(string key)
    {
        return await _db.KeyExistsAsync(key);
    }

    /// <summary>刷新过期时间</summary>
    public async Task RefreshExpiryAsync(string key, TimeSpan? expiry = null)
    {
        await _db.KeyExpireAsync(key, expiry ?? _defaultExpiry);
    }

    /// <summary>获取或设置缓存</summary>
    public async Task<T> GetOrSetAsync<T>(string key, Func<Task<T>> factory, TimeSpan? expiry = null)
    {
        var cached = await GetAsync<T>(key);
        if (cached != null)
            return cached;

        var value = await factory();
        await SetAsync(key, value, expiry);
        return value;
    }

    /// <summary>获取匹配模式的所有键</summary>
    public IEnumerable<string> GetKeys(string pattern)
    {
        var server = _redis.GetServer(_redis.GetEndPoints()[0]);
        return server.Keys(pattern: pattern).Select(k => k.ToString());
    }

    /// <summary>批量删除匹配模式的键</summary>
    public async Task RemoveByPatternAsync(string pattern)
    {
        var keys = GetKeys(pattern).ToArray();
        foreach (var key in keys)
        {
            await _db.KeyDeleteAsync(key);
        }
    }

    public void Dispose()
    {
        _redis.Dispose();
    }
}
