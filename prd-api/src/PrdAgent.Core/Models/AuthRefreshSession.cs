namespace PrdAgent.Core.Models;

/// <summary>
/// Refresh 会话（存 Redis，按 userId + clientType + sessionKey 唯一）
/// </summary>
public class AuthRefreshSession
{
    public string UserId { get; set; } = string.Empty;
    public string ClientType { get; set; } = string.Empty; // admin/desktop
    public string SessionKey { get; set; } = string.Empty;

    // refresh token 不落明文，只存 hash
    public string RefreshTokenHash { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime LastActiveAt { get; set; } = DateTime.UtcNow;
}


