namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Token用量统计服务接口
/// </summary>
public interface ITokenUsageService
{
    /// <summary>记录Token使用量</summary>
    Task RecordUsageAsync(string userId, string sessionId, int inputTokens, int outputTokens);

    /// <summary>获取用户今日用量</summary>
    Task<TokenUsageSummary> GetDailyUsageAsync(string userId);

    /// <summary>获取用户月度用量</summary>
    Task<TokenUsageSummary> GetMonthlyUsageAsync(string userId);

    /// <summary>获取会话用量</summary>
    Task<TokenUsageSummary> GetSessionUsageAsync(string sessionId);

    /// <summary>获取全局用量统计</summary>
    Task<GlobalTokenUsage> GetGlobalStatsAsync();
}

/// <summary>
/// Token用量汇总
/// </summary>
public class TokenUsageSummary
{
    public int TotalInputTokens { get; set; }
    public int TotalOutputTokens { get; set; }
    public int TotalTokens => TotalInputTokens + TotalOutputTokens;
    public int RequestCount { get; set; }
    public DateTime PeriodStart { get; set; }
    public DateTime PeriodEnd { get; set; }
}

/// <summary>
/// 全局Token用量统计
/// </summary>
public class GlobalTokenUsage
{
    public long TotalTokensAllTime { get; set; }
    public int TotalTokensToday { get; set; }
    public int TotalTokensThisMonth { get; set; }
    public int TotalRequestsToday { get; set; }
    public int ActiveUsersToday { get; set; }
}



