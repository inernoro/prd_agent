using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Automation;

/// <summary>
/// 站内信动作执行器：创建 AdminNotification 记录
/// </summary>
public class AdminNotificationActionExecutor : IActionExecutor
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminNotificationActionExecutor> _logger;

    public string ActionType => "admin_notification";

    public AdminNotificationActionExecutor(
        MongoDbContext db,
        ILogger<AdminNotificationActionExecutor> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<ActionExecuteResult> ExecuteAsync(
        AutomationRule rule,
        AutomationAction action,
        AutomationEventPayload payload)
    {
        try
        {
            var level = action.NotifyLevel ?? "info";
            var userIds = action.NotifyUserIds;

            // 如果指定了用户列表，为每个用户创建通知；否则创建全局通知
            if (userIds != null && userIds.Count > 0)
            {
                foreach (var userId in userIds)
                {
                    await CreateNotificationAsync(rule, payload, level, userId);
                }
            }
            else
            {
                // 全局通知（TargetUserId = null）
                await CreateNotificationAsync(rule, payload, level, null);
            }

            return new ActionExecuteResult { Success = true };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create admin notification for rule {RuleId}", rule.Id);
            return new ActionExecuteResult
            {
                Success = false,
                ErrorMessage = ex.Message
            };
        }
    }

    private async Task CreateNotificationAsync(
        AutomationRule rule,
        AutomationEventPayload payload,
        string level,
        string? targetUserId)
    {
        var key = $"automation:{rule.Id}:{payload.EventType}:{DateTime.UtcNow:yyyyMMddHH}";
        if (targetUserId != null)
            key += $":{targetUserId}";

        // 幂等检查
        var existing = await _db.AdminNotifications
            .Find(n => n.Key == key)
            .FirstOrDefaultAsync();

        if (existing != null) return;

        var notification = new AdminNotification
        {
            Key = key,
            TargetUserId = targetUserId,
            Title = payload.Title,
            Message = payload.Content,
            Level = level,
            Source = "automation",
            ExpiresAt = DateTime.UtcNow.AddDays(7)
        };

        await _db.AdminNotifications.InsertOneAsync(notification);
        _logger.LogInformation(
            "Created admin notification for rule {RuleId}, target={Target}",
            rule.Id, targetUserId ?? "(global)");
    }
}
