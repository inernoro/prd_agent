using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// MAP 登录有效期：会话滑动窗口默认 7 天，每次访问 Touch 即续满（「只要在用就不会掉登录」）；
/// tokenVersion 作为撤销台账单独算 TTL —— 必须同时长过会话窗口和 access token，
/// 否则要么放行已撤销的旧 token，要么把合法 token 误判成已撤销。
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
    public async Task Touch_AlsoRenewsExistingTokenVersionKey()
    {
        var cache = new FakeCache();
        var service = new AuthSessionService(cache, Secret, slidingDays: 7);
        var (sessionKey, _) = await service.CreateRefreshSessionAsync("u1", "admin");
        var tvKey = CacheKeys.ForAuthTokenVersion("u1", "admin");

        await service.BumpTokenVersionAsync("u1", "admin");   // 用户被踢过一次 → tv=2
        cache.Expirations[tvKey] = TimeSpan.FromMinutes(1);   // 模拟 tv 键即将过期

        await service.TouchAsync("u1", "admin", sessionKey);

        // tv 键若先于 access token 过期，GetTokenVersionAsync 退回默认 1，
        // 手里 tv=2 的有效 token 会被误判成已撤销 → 平白掉登录。所以 Touch 必须一起续。
        Assert.Equal(service.TokenVersionTtl, cache.Expirations[tvKey]);
        Assert.Equal(2, await service.GetTokenVersionAsync("u1", "admin"));
    }

    [Fact]
    public async Task Touch_DoesNotCreateTokenVersionKeyWhenAbsent()
    {
        var cache = new FakeCache();
        var service = new AuthSessionService(cache, Secret, slidingDays: 7);
        var (sessionKey, _) = await service.CreateRefreshSessionAsync("u1", "admin");

        await service.TouchAsync("u1", "admin", sessionKey);

        // 从没被踢过的用户不该凭空多出一条撤销记录（Redis 对不存在的键 EXPIRE 也是 no-op）。
        Assert.False(cache.Expirations.ContainsKey(CacheKeys.ForAuthTokenVersion("u1", "admin")));
    }

    [Fact]
    public async Task TokenVersion_OutlivesTheAccessToken()
    {
        var cache = new FakeCache();
        var service = new AuthSessionService(cache, Secret, slidingDays: 7);

        await service.BumpTokenVersionAsync("u1", "admin");

        // tokenVersion 是撤销台账，必须活得比它要撤销的 access token 久：
        // 短了会让已撤销的旧版本 token 在剩余寿命里重新被放行，也会让合法 token 被误判成已撤销。
        Assert.True(service.TokenVersionTtl > TimeSpan.FromDays(7));
        Assert.Equal(service.TokenVersionTtl, cache.Expirations[CacheKeys.ForAuthTokenVersion("u1", "admin")]);
    }

    [Theory]
    [InlineData(1, 7 * 24 * 60)]    // 会话窗口被配得比 access token 短 —— 最危险的组合
    [InlineData(7, 7 * 24 * 60)]    // 默认组合
    [InlineData(30, 60)]            // 会话窗口远长于 access token
    public void TokenVersionTtl_NeverShorterThanEitherWindow(int slidingDays, int accessTokenMinutes)
    {
        var service = new AuthSessionService(new FakeCache(), Secret, slidingDays, accessTokenMinutes);

        Assert.True(service.TokenVersionTtl >= service.SlidingTtl);
        Assert.True(service.TokenVersionTtl > TimeSpan.FromMinutes(accessTokenMinutes));
    }

    [Theory]
    [InlineData(0, AuthTokenLifetimes.DefaultAccessTokenMinutes)]   // 未配置
    [InlineData(-30, AuthTokenLifetimes.DefaultAccessTokenMinutes)] // 配错成负数
    [InlineData(60, 60)]
    public void NormalizeAccessTokenMinutes_FallsBackOnIllegalValues(int configured, int expected)
    {
        // 0 / 负值必须在「构造 JwtService」和「回报 expiresIn」两处得到同一个归一化结果，
        // 否则会签出立刻过期的 token 却宣称有效 7 天，登录即 401。
        Assert.Equal(expected, AuthTokenLifetimes.NormalizeAccessTokenMinutes(configured));
    }

    [Fact]
    public void AccessTokenLifetime_IsReadThroughTheSharedHelperEverywhere()
    {
        // 三个读取点（构造 JwtService / 登录回报 expiresIn / SSO 登录）必须共用同一套归一化，
        // 各写各的兜底一定会漂移 —— 这正是本条守卫要拦的回归。
        foreach (var relativePath in new[]
                 {
                     "prd-api/src/PrdAgent.Api/Program.cs",
                     "prd-api/src/PrdAgent.Api/Controllers/AuthController.cs",
                     "prd-api/src/PrdAgent.Api/Controllers/MiduoPlanetSsoController.cs",
                 })
        {
            var source = ReadRepoFile(relativePath);
            Assert.True(
                source.Contains("AuthTokenLifetimes.NormalizeAccessTokenMinutes", StringComparison.Ordinal),
                $"{relativePath} 读取 Jwt:AccessTokenMinutes 时必须走 AuthTokenLifetimes.NormalizeAccessTokenMinutes");
        }
    }

    private static string ReadRepoFile(string relativePath)
    {
        var fullPath = Path.Combine(LocateRepoRoot(), relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(fullPath), $"找不到文件: {fullPath}");
        return File.ReadAllText(fullPath);
    }

    // 与 RateLimitPipelineOrderTests 同一套定位方式，避免两处走不同的仓库根判定。
    private static string LocateRepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "AGENTS.md"))
                && Directory.Exists(Path.Combine(directory.FullName, "prd-api")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
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
