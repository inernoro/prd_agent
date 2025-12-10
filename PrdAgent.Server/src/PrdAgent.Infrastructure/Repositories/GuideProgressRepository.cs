using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Repositories;

/// <summary>
/// 引导进度仓储实现（使用Redis缓存）
/// </summary>
public class GuideProgressRepository : IGuideProgressRepository
{
    private readonly ICacheManager _cache;
    private const string ProgressKeyPrefix = "guide:progress:";
    private const string UserProgressKeyPrefix = "guide:user:";
    private static readonly TimeSpan ProgressExpiry = TimeSpan.FromDays(7);

    public GuideProgressRepository(ICacheManager cache)
    {
        _cache = cache;
    }

    public async Task SaveProgressAsync(GuideProgress progress)
    {
        progress.LastUpdatedAt = DateTime.UtcNow;
        
        // 保存进度
        var progressKey = $"{ProgressKeyPrefix}{progress.SessionId}";
        await _cache.SetAsync(progressKey, progress, ProgressExpiry);

        // 更新用户进度索引
        var userKey = $"{UserProgressKeyPrefix}{progress.UserId}";
        var userProgressIds = await _cache.GetAsync<List<string>>(userKey) ?? new List<string>();
        
        if (!userProgressIds.Contains(progress.SessionId))
        {
            userProgressIds.Add(progress.SessionId);
            // 只保留最近10个进度
            if (userProgressIds.Count > 10)
            {
                userProgressIds = userProgressIds.TakeLast(10).ToList();
            }
            await _cache.SetAsync(userKey, userProgressIds, ProgressExpiry);
        }
    }

    public async Task<GuideProgress?> GetProgressAsync(string sessionId)
    {
        var progressKey = $"{ProgressKeyPrefix}{sessionId}";
        return await _cache.GetAsync<GuideProgress>(progressKey);
    }

    public async Task<List<GuideProgress>> GetUserProgressAsync(string userId)
    {
        var userKey = $"{UserProgressKeyPrefix}{userId}";
        var progressIds = await _cache.GetAsync<List<string>>(userKey);
        
        if (progressIds == null || progressIds.Count == 0)
            return new List<GuideProgress>();

        var progresses = new List<GuideProgress>();
        foreach (var sessionId in progressIds)
        {
            var progress = await GetProgressAsync(sessionId);
            if (progress != null)
            {
                progresses.Add(progress);
            }
        }

        return progresses.OrderByDescending(p => p.LastUpdatedAt).ToList();
    }

    public async Task DeleteProgressAsync(string sessionId)
    {
        var progressKey = $"{ProgressKeyPrefix}{sessionId}";
        await _cache.RemoveAsync(progressKey);
    }
}


