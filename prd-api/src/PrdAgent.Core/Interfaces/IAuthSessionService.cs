namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 认证会话服务（Refresh 会话 + 多端独立计时 + TokenVersion）
/// </summary>
public interface IAuthSessionService
{
    /// <summary>创建 refresh 会话（返回 sessionKey 与 refreshToken）</summary>
    Task<(string SessionKey, string RefreshToken)> CreateRefreshSessionAsync(string userId, string clientType, CancellationToken ct = default);

    /// <summary>验证 refreshToken 是否匹配且会话存在</summary>
    Task<bool> ValidateRefreshTokenAsync(string userId, string clientType, string sessionKey, string refreshToken, CancellationToken ct = default);

    /// <summary>滑动续期：将 refresh 会话 TTL 重置为 now+72h</summary>
    Task TouchAsync(string userId, string clientType, string sessionKey, CancellationToken ct = default);

    /// <summary>删除指定用户在指定端的全部 refresh 会话</summary>
    Task RemoveAllRefreshSessionsAsync(string userId, string clientType, CancellationToken ct = default);

    /// <summary>获取 tokenVersion（不存在则返回 1）</summary>
    Task<int> GetTokenVersionAsync(string userId, string clientType, CancellationToken ct = default);

    /// <summary>提升 tokenVersion（用于立刻踢下线当前端所有 access token），返回新版本</summary>
    Task<int> BumpTokenVersionAsync(string userId, string clientType, CancellationToken ct = default);
}


