using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 基于 Redis 的认证会话服务：
/// - refresh session（3天滑动过期，按端独立）
/// - tokenVersion（踢下线立即生效）
/// </summary>
public class AuthSessionService : IAuthSessionService
{
    // 统一会话生命周期：Refresh Session 与 Token Version 同为 3 天
    private static readonly TimeSpan SessionTtl = TimeSpan.FromDays(3);
    private readonly ICacheManager _cache;
    private readonly string _hmacSecret;

    public AuthSessionService(ICacheManager cache, string hmacSecret)
    {
        _cache = cache;
        _hmacSecret = string.IsNullOrWhiteSpace(hmacSecret) ? "default-secret" : hmacSecret;
    }

    private static string NormalizeClientType(string clientType)
    {
        var ct = (clientType ?? string.Empty).Trim().ToLowerInvariant();
        return ct is "admin" or "desktop" ? ct : "desktop";
    }

    private string HashRefreshToken(string refreshToken)
    {
        var token = refreshToken ?? string.Empty;
        var keyBytes = Encoding.UTF8.GetBytes(_hmacSecret);
        var dataBytes = Encoding.UTF8.GetBytes(token);
        var hash = HMACSHA256.HashData(keyBytes, dataBytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    public async Task<(string SessionKey, string RefreshToken)> CreateRefreshSessionAsync(
        string userId,
        string clientType,
        CancellationToken ct = default)
    {
        var uid = (userId ?? string.Empty).Trim();
        var ctNorm = NormalizeClientType(clientType);
        var sessionKey = Guid.NewGuid().ToString("N");
        var refreshToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(64));

        var session = new AuthRefreshSession
        {
            UserId = uid,
            ClientType = ctNorm,
            SessionKey = sessionKey,
            RefreshTokenHash = HashRefreshToken(refreshToken),
            CreatedAt = DateTime.UtcNow,
            LastActiveAt = DateTime.UtcNow
        };

        var key = CacheKeys.ForAuthRefresh(uid, ctNorm, sessionKey);
        await _cache.SetAsync(key, session, SessionTtl);
        return (sessionKey, refreshToken);
    }

    public async Task<bool> ValidateRefreshTokenAsync(
        string userId,
        string clientType,
        string sessionKey,
        string refreshToken,
        CancellationToken ct = default)
    {
        var uid = (userId ?? string.Empty).Trim();
        var ctNorm = NormalizeClientType(clientType);
        var sk = (sessionKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid) || string.IsNullOrWhiteSpace(sk)) return false;

        var key = CacheKeys.ForAuthRefresh(uid, ctNorm, sk);
        var session = await _cache.GetAsync<AuthRefreshSession>(key);
        if (session == null) return false;

        var hash = HashRefreshToken(refreshToken);
        if (!string.Equals(session.RefreshTokenHash, hash, StringComparison.Ordinal))
        {
            return false;
        }

        // 验证成功即视为活跃：刷新 TTL
        await _cache.RefreshExpiryAsync(key, SessionTtl);
        return true;
    }

    public async Task TouchAsync(string userId, string clientType, string sessionKey, CancellationToken ct = default)
    {
        var uid = (userId ?? string.Empty).Trim();
        var ctNorm = NormalizeClientType(clientType);
        var sk = (sessionKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid) || string.IsNullOrWhiteSpace(sk)) return;

        var key = CacheKeys.ForAuthRefresh(uid, ctNorm, sk);
        // 仅刷新 TTL（O(1)），不强制读写 value，降低每次请求开销
        await _cache.RefreshExpiryAsync(key, SessionTtl);
    }

    public async Task RemoveAllRefreshSessionsAsync(string userId, string clientType, CancellationToken ct = default)
    {
        var uid = (userId ?? string.Empty).Trim();
        var ctNorm = NormalizeClientType(clientType);
        if (string.IsNullOrWhiteSpace(uid)) return;

        await _cache.RemoveByPatternAsync(CacheKeys.ForAuthRefreshPattern(uid, ctNorm));
    }

    public async Task<int> GetTokenVersionAsync(string userId, string clientType, CancellationToken ct = default)
    {
        var uid = (userId ?? string.Empty).Trim();
        var ctNorm = NormalizeClientType(clientType);
        if (string.IsNullOrWhiteSpace(uid)) return 1;

        var key = CacheKeys.ForAuthTokenVersion(uid, ctNorm);
        // ICacheManager.GetAsync<T> 对值类型缺省返回 default(T)，因此不存在时会得到 0
        var v = await _cache.GetAsync<int>(key);
        return v < 1 ? 1 : v;
    }

    public async Task<int> BumpTokenVersionAsync(string userId, string clientType, CancellationToken ct = default)
    {
        var uid = (userId ?? string.Empty).Trim();
        var ctNorm = NormalizeClientType(clientType);
        if (string.IsNullOrWhiteSpace(uid)) return 1;

        var key = CacheKeys.ForAuthTokenVersion(uid, ctNorm);
        var current = await GetTokenVersionAsync(uid, ctNorm, ct);
        var next = current + 1;
        // tokenVersion 需要比 Access Token 生命周期更长，否则版本过期后会误判为已撤销
        await _cache.SetAsync(key, next, expiry: SessionTtl);
        return next;
    }
}


