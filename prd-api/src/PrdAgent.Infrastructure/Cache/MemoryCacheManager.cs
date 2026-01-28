using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Cache;

/// <summary>
/// 内存缓存管理器 - Redis 不可用时的 fallback
/// 注意：仅用于开发环境，不支持分布式场景
/// </summary>
public class MemoryCacheManager : ICacheManager
{
    private readonly ConcurrentDictionary<string, CacheEntry> _cache = new();
    private readonly TimeSpan _defaultExpiry;
    private readonly Timer _cleanupTimer;

    private class CacheEntry
    {
        public object? Value { get; set; }
        public DateTime? ExpiresAt { get; set; }
    }

    public MemoryCacheManager(int defaultExpiryMinutes = 30)
    {
        _defaultExpiry = TimeSpan.FromMinutes(defaultExpiryMinutes);
        // 每分钟清理过期项
        _cleanupTimer = new Timer(CleanupExpired, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    private void CleanupExpired(object? state)
    {
        var now = DateTime.UtcNow;
        var expiredKeys = _cache.Where(kv => kv.Value.ExpiresAt.HasValue && kv.Value.ExpiresAt < now)
                                .Select(kv => kv.Key)
                                .ToList();
        foreach (var key in expiredKeys)
        {
            _cache.TryRemove(key, out _);
        }
    }

    public Task<T?> GetAsync<T>(string key)
    {
        if (_cache.TryGetValue(key, out var entry))
        {
            if (!entry.ExpiresAt.HasValue || entry.ExpiresAt > DateTime.UtcNow)
            {
                return Task.FromResult((T?)entry.Value);
            }
            _cache.TryRemove(key, out _);
        }
        return Task.FromResult(default(T?));
    }

    public Task SetAsync<T>(string key, T value, TimeSpan? expiry = null)
    {
        var expiresAt = expiry.HasValue
            ? DateTime.UtcNow.Add(expiry.Value)
            : DateTime.UtcNow.Add(_defaultExpiry);

        _cache[key] = new CacheEntry { Value = value, ExpiresAt = expiresAt };
        return Task.CompletedTask;
    }

    public Task RemoveAsync(string key)
    {
        _cache.TryRemove(key, out _);
        return Task.CompletedTask;
    }

    public Task<bool> ExistsAsync(string key)
    {
        if (_cache.TryGetValue(key, out var entry))
        {
            if (!entry.ExpiresAt.HasValue || entry.ExpiresAt > DateTime.UtcNow)
            {
                return Task.FromResult(true);
            }
            _cache.TryRemove(key, out _);
        }
        return Task.FromResult(false);
    }

    public Task RefreshExpiryAsync(string key, TimeSpan? expiry = null)
    {
        if (_cache.TryGetValue(key, out var entry))
        {
            entry.ExpiresAt = expiry.HasValue
                ? DateTime.UtcNow.Add(expiry.Value)
                : DateTime.UtcNow.Add(_defaultExpiry);
        }
        return Task.CompletedTask;
    }

    public async Task<T> GetOrSetAsync<T>(string key, Func<Task<T>> factory, TimeSpan? expiry = null)
    {
        var existing = await GetAsync<T>(key);
        if (existing != null)
        {
            return existing;
        }

        var value = await factory();
        await SetAsync(key, value, expiry);
        return value;
    }

    public IEnumerable<string> GetKeys(string pattern)
    {
        // 简单的通配符匹配：* -> .*
        var regex = new Regex("^" + Regex.Escape(pattern).Replace("\\*", ".*") + "$");
        return _cache.Keys.Where(k => regex.IsMatch(k));
    }

    public Task RemoveByPatternAsync(string pattern)
    {
        var keys = GetKeys(pattern).ToList();
        foreach (var key in keys)
        {
            _cache.TryRemove(key, out _);
        }
        return Task.CompletedTask;
    }

    public Task FlushDatabaseAsync()
    {
        _cache.Clear();
        return Task.CompletedTask;
    }
}
