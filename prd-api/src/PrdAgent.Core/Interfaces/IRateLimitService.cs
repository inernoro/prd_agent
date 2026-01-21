namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 限流服务接口（基于 Redis 实现分布式限流）
/// </summary>
public interface IRateLimitService
{
    /// <summary>
    /// 检查请求是否被允许
    /// </summary>
    /// <param name="clientId">客户端标识（userId 或 IP）</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>
    /// allowed: 是否允许请求
    /// reason: 如果被拒绝，原因描述
    /// </returns>
    Task<(bool allowed, string? reason)> CheckRequestAsync(string clientId, CancellationToken ct = default);

    /// <summary>
    /// 请求完成后调用，减少并发计数
    /// </summary>
    Task RequestCompletedAsync(string clientId, CancellationToken ct = default);

    /// <summary>
    /// 检查用户是否豁免限流
    /// </summary>
    Task<bool> IsExemptAsync(string userId, CancellationToken ct = default);

    /// <summary>
    /// 设置用户的限流豁免状态
    /// </summary>
    Task SetExemptAsync(string userId, bool exempt, CancellationToken ct = default);

    /// <summary>
    /// 获取用户的自定义限流配置
    /// </summary>
    Task<UserRateLimitConfig?> GetUserConfigAsync(string userId, CancellationToken ct = default);

    /// <summary>
    /// 设置用户的自定义限流配置
    /// </summary>
    Task SetUserConfigAsync(string userId, UserRateLimitConfig config, CancellationToken ct = default);

    /// <summary>
    /// 删除用户的自定义限流配置（恢复默认）
    /// </summary>
    Task RemoveUserConfigAsync(string userId, CancellationToken ct = default);

    /// <summary>
    /// 获取全局默认限流配置
    /// </summary>
    Task<GlobalRateLimitConfig> GetGlobalConfigAsync(CancellationToken ct = default);

    /// <summary>
    /// 设置全局默认限流配置
    /// </summary>
    Task SetGlobalConfigAsync(GlobalRateLimitConfig config, CancellationToken ct = default);

    /// <summary>
    /// 获取所有被豁免的用户 ID 列表
    /// </summary>
    Task<IReadOnlyList<string>> GetAllExemptUsersAsync(CancellationToken ct = default);

    /// <summary>
    /// 获取所有有自定义配置的用户
    /// </summary>
    Task<IReadOnlyList<(string userId, UserRateLimitConfig config)>> GetAllUserConfigsAsync(CancellationToken ct = default);
}

/// <summary>
/// 用户限流配置
/// </summary>
public class UserRateLimitConfig
{
    /// <summary>每分钟最大请求数</summary>
    public int MaxRequestsPerMinute { get; set; } = 600;

    /// <summary>最大并发请求数</summary>
    public int MaxConcurrentRequests { get; set; } = 100;
}

/// <summary>
/// 全局限流配置
/// </summary>
public class GlobalRateLimitConfig
{
    /// <summary>每分钟最大请求数（默认 600）</summary>
    public int MaxRequestsPerMinute { get; set; } = 600;

    /// <summary>最大并发请求数（默认 100）</summary>
    public int MaxConcurrentRequests { get; set; } = 100;
}
