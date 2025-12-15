using PrdAgent.Core.Interfaces;

namespace PrdAgent.Core.Services;

/// <summary>
/// Token用量统计服务实现
/// </summary>
public class TokenUsageService : ITokenUsageService
{
    private readonly ICacheManager _cache;
    private const string DailyUsagePrefix = "token:daily:";
    private const string MonthlyUsagePrefix = "token:monthly:";
    private const string SessionUsagePrefix = "token:session:";
    private const string GlobalStatsKey = "token:global:stats";

    public TokenUsageService(ICacheManager cache)
    {
        _cache = cache;
    }

    public async Task RecordUsageAsync(string userId, string sessionId, int inputTokens, int outputTokens)
    {
        var today = DateTime.UtcNow.Date;
        var month = new DateTime(today.Year, today.Month, 1);

        // 更新用户日用量
        var dailyKey = $"{DailyUsagePrefix}{userId}:{today:yyyyMMdd}";
        var dailyUsage = await _cache.GetAsync<TokenUsageSummary>(dailyKey) ?? new TokenUsageSummary
        {
            PeriodStart = today,
            PeriodEnd = today.AddDays(1).AddTicks(-1)
        };
        dailyUsage.TotalInputTokens += inputTokens;
        dailyUsage.TotalOutputTokens += outputTokens;
        dailyUsage.RequestCount++;
        await _cache.SetAsync(dailyKey, dailyUsage, TimeSpan.FromDays(2));

        // 更新用户月用量
        var monthlyKey = $"{MonthlyUsagePrefix}{userId}:{month:yyyyMM}";
        var monthlyUsage = await _cache.GetAsync<TokenUsageSummary>(monthlyKey) ?? new TokenUsageSummary
        {
            PeriodStart = month,
            PeriodEnd = month.AddMonths(1).AddTicks(-1)
        };
        monthlyUsage.TotalInputTokens += inputTokens;
        monthlyUsage.TotalOutputTokens += outputTokens;
        monthlyUsage.RequestCount++;
        await _cache.SetAsync(monthlyKey, monthlyUsage, TimeSpan.FromDays(35));

        // 更新会话用量
        var sessionKey = $"{SessionUsagePrefix}{sessionId}";
        var sessionUsage = await _cache.GetAsync<TokenUsageSummary>(sessionKey) ?? new TokenUsageSummary();
        sessionUsage.TotalInputTokens += inputTokens;
        sessionUsage.TotalOutputTokens += outputTokens;
        sessionUsage.RequestCount++;
        await _cache.SetAsync(sessionKey, sessionUsage, TimeSpan.FromHours(2));

        // 更新全局统计
        await UpdateGlobalStatsAsync(inputTokens + outputTokens, userId);
    }

    public async Task<TokenUsageSummary> GetDailyUsageAsync(string userId)
    {
        var today = DateTime.UtcNow.Date;
        var dailyKey = $"{DailyUsagePrefix}{userId}:{today:yyyyMMdd}";
        return await _cache.GetAsync<TokenUsageSummary>(dailyKey) ?? new TokenUsageSummary
        {
            PeriodStart = today,
            PeriodEnd = today.AddDays(1).AddTicks(-1)
        };
    }

    public async Task<TokenUsageSummary> GetMonthlyUsageAsync(string userId)
    {
        var today = DateTime.UtcNow.Date;
        var month = new DateTime(today.Year, today.Month, 1);
        var monthlyKey = $"{MonthlyUsagePrefix}{userId}:{month:yyyyMM}";
        return await _cache.GetAsync<TokenUsageSummary>(monthlyKey) ?? new TokenUsageSummary
        {
            PeriodStart = month,
            PeriodEnd = month.AddMonths(1).AddTicks(-1)
        };
    }

    public async Task<TokenUsageSummary> GetSessionUsageAsync(string sessionId)
    {
        var sessionKey = $"{SessionUsagePrefix}{sessionId}";
        return await _cache.GetAsync<TokenUsageSummary>(sessionKey) ?? new TokenUsageSummary();
    }

    public async Task<GlobalTokenUsage> GetGlobalStatsAsync()
    {
        return await _cache.GetAsync<GlobalTokenUsage>(GlobalStatsKey) ?? new GlobalTokenUsage();
    }

    private async Task UpdateGlobalStatsAsync(int tokens, string userId)
    {
        var stats = await _cache.GetAsync<GlobalTokenUsage>(GlobalStatsKey) ?? new GlobalTokenUsage();
        stats.TotalTokensAllTime += tokens;
        stats.TotalTokensToday += tokens;
        stats.TotalTokensThisMonth += tokens;
        stats.TotalRequestsToday++;
        
        // 简化的活跃用户统计（实际应该用Set）
        await _cache.SetAsync(GlobalStatsKey, stats, TimeSpan.FromDays(1));
    }
}
