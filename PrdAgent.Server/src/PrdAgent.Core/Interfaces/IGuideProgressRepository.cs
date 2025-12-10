using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 引导进度仓储接口
/// </summary>
public interface IGuideProgressRepository
{
    /// <summary>保存进度</summary>
    Task SaveProgressAsync(GuideProgress progress);

    /// <summary>获取进度</summary>
    Task<GuideProgress?> GetProgressAsync(string sessionId);

    /// <summary>获取用户的所有进度</summary>
    Task<List<GuideProgress>> GetUserProgressAsync(string userId);

    /// <summary>删除进度</summary>
    Task DeleteProgressAsync(string sessionId);
}

/// <summary>
/// 引导进度实体
/// </summary>
public class GuideProgress
{
    public string SessionId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string DocumentId { get; set; } = string.Empty;
    public UserRole Role { get; set; }
    public int CurrentStep { get; set; }
    public int TotalSteps { get; set; }
    public List<int> CompletedSteps { get; set; } = new();
    public Dictionary<int, string> StepContents { get; set; } = new();
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime LastUpdatedAt { get; set; } = DateTime.UtcNow;
    public bool IsCompleted { get; set; }
}

