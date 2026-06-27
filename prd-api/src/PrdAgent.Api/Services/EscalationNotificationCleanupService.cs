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
/// 滚动发布窗口防护：若发布期间旧实例仍在跑催办 Worker，可能在新实例首次清扫之后才插入
/// 最后一批催办。故清扫不是只跑一次，而是在一个有界窗口内周期重复（见 SweepCount/SweepInterval），
/// 覆盖发布重叠期后进入空闲。生产者已随本次发布删除，窗口结束后不会再有新记录产生，
/// 无需常驻清扫，也不在通知列表查询里留永久过滤逻辑。
///
/// 幂等：删完后重复扫描只删 0 条，无副作用。
/// </summary>
public class EscalationNotificationCleanupService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly ILogger<EscalationNotificationCleanupService> _logger;

    /// <summary>清扫次数与间隔：覆盖约 30s + 10 × 2min ≈ 20 分钟的发布重叠窗口后停止。</summary>
    private const int SweepCount = 10;
    private static readonly TimeSpan SweepInterval = TimeSpan.FromMinutes(2);

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

        var filter = Builders<AdminNotification>.Filter.Or(
            Builders<AdminNotification>.Filter.Eq(x => x.Source, "pm-reminder"),
            Builders<AdminNotification>.Filter.Regex(x => x.Key, new BsonRegularExpression("^defect-escalation"))
        );

        for (var i = 0; i < SweepCount && !stoppingToken.IsCancellationRequested; i++)
        {
            try
            {
                using var scope = _services.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

                var result = await db.AdminNotifications.DeleteManyAsync(filter, CancellationToken.None);
                if (result.DeletedCount > 0)
                {
                    _logger.LogInformation(
                        "EscalationNotificationCleanupService: 已清理 {Count} 条存量催办通知（pm-reminder / defect-escalation），第 {Round}/{Total} 轮",
                        result.DeletedCount, i + 1, SweepCount);
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _logger.LogError(ex, "EscalationNotificationCleanupService 清理存量催办通知失败（第 {Round}/{Total} 轮）", i + 1, SweepCount);
            }

            if (i < SweepCount - 1)
            {
                try
                {
                    await Task.Delay(SweepInterval, stoppingToken);
                }
                catch (OperationCanceledException) { break; }
            }
        }
        // 清扫窗口结束后进入空闲：生产者已删除，不会再有新记录。
    }
}
