using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 基于 Redis 的认证会话服务：
/// - refresh session（默认 7 天滑动过期，按端独立；每次请求 Touch 即续满）
/// - tokenVersion（踢下线立即生效）
/// </summary>
public class AuthSessionService : IAuthSessionService
{
    /// <summary>默认滑动窗口：7 天（用户诉求「超长登录期 + 用后自动延长」）。口径 SSOT 见 AuthTokenLifetimes。</summary>
    public const int DefaultSlidingDays = AuthTokenLifetimes.DefaultSessionSlidingDays;
    /// <summary>默认 access token 时长（分钟）：7 天，与 <c>Jwt:AccessTokenMinutes</c> 默认值一致。</summary>
    public const int DefaultAccessTokenMinutes = AuthTokenLifetimes.DefaultAccessTokenMinutes;
    /// <summary>tokenVersion 相对 access token 生命周期多留的余量（时钟偏差 + 校验抖动）。</summary>
    private static readonly TimeSpan TokenVersionSkew = TimeSpan.FromDays(1);

    // Refresh Session 走滑动窗口；tokenVersion 另算（见 _tokenVersionTtl）
    private readonly TimeSpan _sessionTtl;
    private readonly TimeSpan _tokenVersionTtl;
    private readonly ICacheManager _cache;
    private readonly string _hmacSecret;

    public AuthSessionService(
        ICacheManager cache,
        string hmacSecret,
        int slidingDays = DefaultSlidingDays,
        int accessTokenMinutes = DefaultAccessTokenMinutes)
    {
        _cache = cache;
        _hmacSecret = string.IsNullOrWhiteSpace(hmacSecret) ? "default-secret" : hmacSecret;
        _sessionTtl = TimeSpan.FromDays(AuthTokenLifetimes.NormalizeSessionSlidingDays(slidingDays));

        // tokenVersion 是撤销台账，**必须活得比它要撤销的 access token 久**：
        // 会话窗口与 access token 时长是两个独立配置（窗口可配到 1 天，token 可配到 7 天），
        // 一旦 tv 键先过期，GetTokenVersionAsync 退回默认值 1，
        // 已被撤销的 v1 token 就会在剩余寿命里重新被放行。故取两者较大值再加时钟余量。
        var accessMinutes = AuthTokenLifetimes.NormalizeAccessTokenMinutes(accessTokenMinutes);
        var accessTokenTtl = TimeSpan.FromMinutes(accessMinutes) + TokenVersionSkew;
        _tokenVersionTtl = accessTokenTtl > _sessionTtl ? accessTokenTtl : _sessionTtl;
    }

    public TimeSpan SlidingTtl => _sessionTtl;

    /// <summary>tokenVersion 台账的 TTL：max(会话窗口, access token 时长 + 时钟余量)。</summary>
    public TimeSpan TokenVersionTtl => _tokenVersionTtl;

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
        await _cache.SetAsync(key, session, _sessionTtl);
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
        await _cache.RefreshExpiryAsync(key, _sessionTtl);
        // tokenVersion 台账也要跟着续：refresh 走的是未鉴权路径，不经过 TouchAsync。
        // 被踢过的用户（tv>=2）在台账临近过期时刷新，会拿到一枚 tv=2 的新 token，
        // 而台账随后过期 → GetTokenVersionAsync 退回 1 → 这枚刚签发的合法 token 反被判成已撤销。
        await _cache.RefreshExpiryAsync(CacheKeys.ForAuthTokenVersion(uid, ctNorm), _tokenVersionTtl);
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
        await _cache.RefreshExpiryAsync(key, _sessionTtl);

        // tokenVersion 也跟着续期：access token 现在与会话窗口同为 7 天，若 tv 键先过期，
        // GetTokenVersionAsync 会退回默认值 1，让「被踢过一次（tv>=2）的用户」手里仍然有效的
        // token 被误判成已撤销 → 平白掉登录。键不存在时 RefreshExpiry 是 no-op，不会凭空复活撤销记录。
        await _cache.RefreshExpiryAsync(CacheKeys.ForAuthTokenVersion(uid, ctNorm), _tokenVersionTtl);
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
        // tokenVersion 必须活得比 access token 久：短了会让已撤销的旧版本 token 重新被放行，
        // 也会让版本过期后的合法 token 被误判成已撤销。TTL 口径见 _tokenVersionTtl。
        await _cache.SetAsync(key, next, expiry: _tokenVersionTtl);
        return next;
    }
}


