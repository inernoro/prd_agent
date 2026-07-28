using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// MAP 登录有效期：会话滑动窗口默认 7 天，每次访问 Touch 即续满（「只要在用就不会掉登录」），
/// 且 refresh 会话 / tokenVersion 共用同一个窗口，避免二者过期时间打架把人提前踢下线。
/// </summary>
public class AuthSessionLifetimeTests
{
    private const string Secret = "auth-session-test-secret";

    [Fact]
    public void DefaultSlidingWindow_IsSevenDays()
    {
        var service = new AuthSessionService(new FakeCache(), Secret);

        Assert.Equal(TimeSpan.FromDays(7), service.SlidingTtl);
        Assert.Equal(7, AuthSessionService.DefaultSlidingDays);
    }

    [Theory]
    [InlineData(0, 7)]     // 未配置/配置为 0 → 回默认值，而不是「0 天」把所有人立刻踢下线
    [InlineData(-3, 7)]    // 负数同理
    [InlineData(1, 1)]
    [InlineData(30, 30)]
    [InlineData(365, 90)]  // 上限收敛，避免配置失误造成事实上永不过期的会话
    public void SlidingWindow_ClampsConfiguredDays(int configuredDays, int expectedDays)
    {
        var service = new AuthSessionService(new FakeCache(), Secret, configuredDays);

        Assert.Equal(TimeSpan.FromDays(expectedDays), service.SlidingTtl);
    }

    [Fact]
    public async Task CreateAndTouch_UseTheSameSlidingWindow()
    {
        var cache = new FakeCache();
        var service = new AuthSessionService(cache, Secret, slidingDays: 7);

        var (sessionKey, _) = await service.CreateRefreshSessionAsync("u1", "admin");
        var key = CacheKeys.ForAuthRefresh("u1", "admin", sessionKey);
        Assert.Equal(TimeSpan.FromDays(7), cache.Expirations[key]);

        // 模拟「窗口快到期时又来了一次请求」：Touch 必须把 TTL 重新续满。
        cache.Expirations[key] = TimeSpan.FromMinutes(1);
        await service.TouchAsync("u1", "admin", sessionKey);
        Assert.Equal(TimeSpan.FromDays(7), cache.Expirations[key]);
    }

    [Fact]
    public async Task TokenVersion_SharesTheSessionWindow()
    {
        var cache = new FakeCache();
        var service = new AuthSessionService(cache, Secret, slidingDays: 7);

        await service.BumpTokenVersionAsync("u1", "admin");

        // tokenVersion 比 access token 活得久是踢下线能立刻生效的前提；
        // 它若先于会话过期，旧 token 会被误判成「已撤销」而提前掉登录。
        Assert.Equal(TimeSpan.FromDays(7), cache.Expirations[CacheKeys.ForAuthTokenVersion("u1", "admin")]);
    }

    /// <summary>只记录「键 → 值 / TTL」的内存缓存，用来断言过期时间，不依赖 Redis。</summary>
    private sealed class FakeCache : ICacheManager
    {
        private readonly Dictionary<string, object?> _values = new();
        public Dictionary<string, TimeSpan?> Expirations { get; } = new();

        public Task<T?> GetAsync<T>(string key)
            => _values.TryGetValue(key, out var value) && value is T typed
                ? Task.FromResult<T?>(typed)
                : Task.FromResult<T?>(default);

        public Task SetAsync<T>(string key, T value, TimeSpan? expiry = null)
        {
            _values[key] = value;
            Expirations[key] = expiry;
            return Task.CompletedTask;
        }

        public Task RemoveAsync(string key)
        {
            _values.Remove(key);
            Expirations.Remove(key);
            return Task.CompletedTask;
        }

        public Task<bool> ExistsAsync(string key) => Task.FromResult(_values.ContainsKey(key));

        public Task RefreshExpiryAsync(string key, TimeSpan? expiry = null)
        {
            if (_values.ContainsKey(key)) Expirations[key] = expiry;
            return Task.CompletedTask;
        }

        public async Task<T> GetOrSetAsync<T>(string key, Func<Task<T>> factory, TimeSpan? expiry = null)
        {
            if (_values.TryGetValue(key, out var existing) && existing is T typed) return typed;
            var created = await factory();
            await SetAsync(key, created, expiry);
            return created;
        }

        public IEnumerable<string> GetKeys(string pattern)
        {
            var prefix = pattern.TrimEnd('*');
            return _values.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)).ToList();
        }

        public Task RemoveByPatternAsync(string pattern)
        {
            foreach (var key in GetKeys(pattern)) { _values.Remove(key); Expirations.Remove(key); }
            return Task.CompletedTask;
        }

        public Task FlushDatabaseAsync()
        {
            _values.Clear();
            Expirations.Clear();
            return Task.CompletedTask;
        }
    }
}
