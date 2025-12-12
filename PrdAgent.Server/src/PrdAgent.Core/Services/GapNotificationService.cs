using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 缺口通知服务实现
/// </summary>
public class GapNotificationService : IGapNotificationService
{
    private readonly ICacheManager _cache;
    private readonly IGroupService _groupService;
    private const string NotificationKeyPrefix = "notification:gap:";
    private const string UserNotificationsPrefix = "notifications:user:";
    private static readonly TimeSpan NotificationExpiry = TimeSpan.FromDays(7);

    public GapNotificationService(ICacheManager cache, IGroupService groupService)
    {
        _cache = cache;
        _groupService = groupService;
    }

    public async Task NotifyNewGapAsync(string groupId, ContentGap gap)
    {
        // 获取群组所有者（PM）
        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null) return;

        var notification = new GapNotification
        {
            UserId = group.OwnerId,
            GroupId = groupId,
            GapId = gap.GapId,
            Title = "发现新的内容缺口",
            Message = $"[{gap.GapType}] {gap.Question}"
        };

        await SaveNotificationAsync(notification);
    }

    public async Task SendSummaryReportAsync(string groupId, string reportContent)
    {
        var group = await _groupService.GetByIdAsync(groupId);
        if (group == null) return;

        var notification = new GapNotification
        {
            UserId = group.OwnerId,
            GroupId = groupId,
            GapId = "",
            Title = "内容缺口汇总报告",
            Message = reportContent.Length > 500 ? reportContent[..500] + "..." : reportContent
        };

        await SaveNotificationAsync(notification);
    }

    public async Task<List<GapNotification>> GetPendingNotificationsAsync(string userId)
    {
        var userKey = $"{UserNotificationsPrefix}{userId}";
        var notificationIds = await _cache.GetAsync<List<string>>(userKey);

        if (notificationIds == null || notificationIds.Count == 0)
            return new List<GapNotification>();

        var notifications = new List<GapNotification>();
        foreach (var id in notificationIds)
        {
            var key = $"{NotificationKeyPrefix}{id}";
            var notification = await _cache.GetAsync<GapNotification>(key);
            if (notification != null && !notification.IsRead)
            {
                notifications.Add(notification);
            }
        }

        return notifications.OrderByDescending(n => n.CreatedAt).ToList();
    }

    public async Task MarkAsReadAsync(string notificationId)
    {
        var key = $"{NotificationKeyPrefix}{notificationId}";
        var notification = await _cache.GetAsync<GapNotification>(key);
        
        if (notification != null)
        {
            notification.IsRead = true;
            await _cache.SetAsync(key, notification, NotificationExpiry);
        }
    }

    private async Task SaveNotificationAsync(GapNotification notification)
    {
        // 保存通知
        var key = $"{NotificationKeyPrefix}{notification.NotificationId}";
        await _cache.SetAsync(key, notification, NotificationExpiry);

        // 更新用户通知索引
        var userKey = $"{UserNotificationsPrefix}{notification.UserId}";
        var notificationIds = await _cache.GetAsync<List<string>>(userKey) ?? new List<string>();
        
        notificationIds.Add(notification.NotificationId);
        
        // 只保留最近50条通知
        if (notificationIds.Count > 50)
        {
            notificationIds = notificationIds.TakeLast(50).ToList();
        }
        
        await _cache.SetAsync(userKey, notificationIds, NotificationExpiry);
    }
}





