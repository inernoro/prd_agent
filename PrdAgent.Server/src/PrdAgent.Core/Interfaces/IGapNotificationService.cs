using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 缺口通知服务接口
/// </summary>
public interface IGapNotificationService
{
    /// <summary>通知PM有新缺口</summary>
    Task NotifyNewGapAsync(string groupId, ContentGap gap);

    /// <summary>发送缺口汇总报告</summary>
    Task SendSummaryReportAsync(string groupId, string reportContent);

    /// <summary>获取待处理缺口通知</summary>
    Task<List<GapNotification>> GetPendingNotificationsAsync(string userId);

    /// <summary>标记通知已读</summary>
    Task MarkAsReadAsync(string notificationId);
}

/// <summary>
/// 缺口通知
/// </summary>
public class GapNotification
{
    public string NotificationId { get; set; } = Guid.NewGuid().ToString();
    public string UserId { get; set; } = string.Empty;
    public string GroupId { get; set; } = string.Empty;
    public string GapId { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool IsRead { get; set; }
}