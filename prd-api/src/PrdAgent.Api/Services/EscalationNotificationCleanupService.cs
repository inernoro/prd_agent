using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 一次性启动任务：清理已删除的催办 Worker（DefectEscalationWorker / PmOverdueReminderWorker）
/// 之前发出的存量 AdminNotification。
///
/// 背景：删除两个催办 Worker 只是停止产生新催办，但它们之前写入的通知带 3 天 ExpiresAt，
/// 用户在上线后最多还会再看到 3 天的「项目待办提醒 / 缺陷催办」噪音——这正是本次要删掉的东西。
/// 故在同一次上线时主动删掉这批存量记录，让噪音立即归零。
///
/// 匹配条件（精确，不误伤其它通知）：
/// - Source == "pm-reminder"（PmOverdueReminderWorker 专用，全仓无其它使用方）
/// - Key 前缀 "defect-escalation"（覆盖 defect-escalation: 与 defect-escalation-leader:；
///   不能按 Source=="defect-agent" 删，那个还被指派/状态变更等正常缺陷通知使用）
///
/// 幂等：Worker 已删除不再产生新记录，删完后重复启动只删 0 条，无副作用。
/// </summary>
public class EscalationNotificationCleanupService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly ILogger<EscalationNotificationCleanupService> _logger;

    public EscalationNotificationCleanupService(IServiceProvider services, ILogger<EscalationNotificationCleanupService> logger)
    {
        _services = services;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
        }
        catch (OperationCanceledException) { return; }

        try
        {
            using var scope = _services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

            var filter = Builders<AdminNotification>.Filter.Or(
                Builders<AdminNotification>.Filter.Eq(x => x.Source, "pm-reminder"),
                Builders<AdminNotification>.Filter.Regex(x => x.Key, new BsonRegularExpression("^defect-escalation"))
            );

            var result = await db.AdminNotifications.DeleteManyAsync(filter, CancellationToken.None);
            if (result.DeletedCount > 0)
            {
                _logger.LogInformation(
                    "EscalationNotificationCleanupService: 已清理 {Count} 条存量催办通知（pm-reminder / defect-escalation）",
                    result.DeletedCount);
            }
        }
        catch (OperationCanceledException) { /* 正常停机 */ }
        catch (Exception ex)
        {
            _logger.LogError(ex, "EscalationNotificationCleanupService 清理存量催办通知失败");
        }
    }
}
