namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 缓存管理器接口
/// </summary>
public interface ICacheManager
{
    /// <summary>获取缓存</summary>
    Task<T?> GetAsync<T>(string key);

    /// <summary>设置缓存</summary>
    Task SetAsync<T>(string key, T value, TimeSpan? expiry = null);

    /// <summary>删除缓存</summary>
    Task RemoveAsync(string key);

    /// <summary>检查键是否存在</summary>
    Task<bool> ExistsAsync(string key);

    /// <summary>刷新过期时间</summary>
    Task RefreshExpiryAsync(string key, TimeSpan? expiry = null);

    /// <summary>获取或设置缓存</summary>
    Task<T> GetOrSetAsync<T>(string key, Func<Task<T>> factory, TimeSpan? expiry = null);

    /// <summary>获取匹配模式的所有键</summary>
    IEnumerable<string> GetKeys(string pattern);

    /// <summary>批量删除匹配模式的键</summary>
    Task RemoveByPatternAsync(string pattern);
}

/// <summary>
/// 缓存键前缀
/// </summary>
public static class CacheKeys
{
    public const string Session = "session:";
    public const string Document = "document:";
    public const string ChatHistory = "chat:history:";
    public const string GroupChatHistory = "chat:history:group:";
    // 群组上下文重置点（用于 LLM 上下文拼接的截断，不影响消息历史）
    public const string GroupContextReset = "chat:reset:group:";
    public const string UserSession = "user:session:";

    // Auth: refresh session 与 tokenVersion
    public const string AuthRefresh = "auth:refresh:";
    public const string AuthTokenVersion = "auth:tv:";
    
    public static string ForSession(string sessionId) => $"{Session}{sessionId}";
    public static string ForDocument(string documentId) => $"{Document}{documentId}";
    public static string ForChatHistory(string sessionId) => $"{ChatHistory}{sessionId}";
    public static string ForGroupChatHistory(string groupId) => $"{GroupChatHistory}{groupId}";
    public static string ForGroupContextReset(string groupId) => $"{GroupContextReset}{groupId}";

    public static string ForAuthRefresh(string userId, string clientType, string sessionKey)
        => $"{AuthRefresh}{userId}:{clientType}:{sessionKey}";

    public static string ForAuthRefreshPattern(string userId, string clientType)
        => $"{AuthRefresh}{userId}:{clientType}:*";

    public static string ForAuthTokenVersion(string userId, string clientType)
        => $"{AuthTokenVersion}{userId}:{clientType}";
}
