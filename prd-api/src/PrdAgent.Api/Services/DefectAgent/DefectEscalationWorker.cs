using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.DefectAgent;

/// <summary>
/// 缺陷超时催办 Worker — 定期扫描超时未处理的缺陷并发送催办通知
/// </summary>
public sealed class DefectEscalationWorker : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<DefectEscalationWorker> _logger;

    /// <summary>严重等级 → 超时阈值（从 submittedAt 计算）</summary>
    private static readonly Dictionary<string, TimeSpan> EscalationThresholds = new()
    {
        [DefectSeverity.Blocker] = TimeSpan.FromHours(2),
        [DefectSeverity.Critical] = TimeSpan.FromHours(4),
        [DefectSeverity.Major] = TimeSpan.FromHours(24),
        [DefectSeverity.Minor] = TimeSpan.FromHours(72),
        [DefectSeverity.Suggestion] = TimeSpan.FromHours(72),
    };

    public DefectEscalationWorker(IServiceScopeFactory scopeFactory, ILogger<DefectEscalationWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // 启动后延迟 30 秒再开始扫描，避免启动时并发压力
        await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await CheckEscalationsAsync();
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[defect-agent] Escalation check failed");
            }

            await Task.Delay(Interval, stoppingToken);
        }
    }

    private async Task CheckEscalationsAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

        var now = DateTime.UtcNow;

        // 查询状态为 submitted / assigned / processing 的活跃缺陷
        var activeStatuses = new[] { DefectStatus.Submitted, DefectStatus.Assigned, DefectStatus.Processing };
        var activeDefects = await db.DefectReports
            .Find(x => activeStatuses.Contains(x.Status) && !x.IsDeleted)
            .ToListAsync(CancellationToken.None);

        var escalatedCount = 0;
        foreach (var defect in activeDefects)
        {
            var baseTime = defect.SubmittedAt ?? defect.CreatedAt;
            var severity = defect.Severity ?? DefectSeverity.Major;

            if (!EscalationThresholds.TryGetValue(severity, out var threshold))
                threshold = TimeSpan.FromHours(24);

            // 检查是否超时
            if (now - baseTime < threshold)
                continue;

            // 检查最小催办间隔（= 阈值本身，避免重复催办）
            if (defect.LastEscalatedAt.HasValue && now - defect.LastEscalatedAt.Value < threshold)
                continue;

            // 确定催办对象
            var targetUserId = defect.AssigneeId;
            if (string.IsNullOrEmpty(targetUserId))
                continue; // 无指派人则跳过

            // 创建催办通知
            var notificationKey = $"defect-escalation:{defect.Id}:{defect.EscalationCount + 1}";
            var elapsedHours = (int)(now - baseTime).TotalHours;
            var notification = new AdminNotification
            {
                Key = notificationKey,
                TargetUserId = targetUserId,
                Title = $"缺陷催办：{defect.DefectNo}",
                Message = $"缺陷 [{defect.Title ?? defect.DefectNo}] 已超时 {elapsedHours} 小时未处理，请尽快跟进",
                Level = severity == DefectSeverity.Blocker ? "error" :
                        severity == DefectSeverity.Critical ? "error" : "warning",
                ActionLabel = "查看详情",
                ActionUrl = $"/defect-agent?id={defect.Id}",
                Source = "defect-agent",
                ExpiresAt = DateTime.UtcNow.AddDays(3)
            };

            await db.AdminNotifications.InsertOneAsync(notification, cancellationToken: CancellationToken.None);

            // 如果是 blocker，同时通知团队 leader
            if (severity == DefectSeverity.Blocker && !string.IsNullOrEmpty(defect.TeamId))
            {
                var teamMembers = await db.ReportTeamMembers
                    .Find(x => x.TeamId == defect.TeamId && x.Role == ReportTeamRole.Leader)
                    .ToListAsync(CancellationToken.None);

                foreach (var leader in teamMembers)
                {
                    if (leader.UserId == targetUserId) continue; // 避免重复

                    var leaderNotification = new AdminNotification
                    {
                        Key = $"defect-escalation-leader:{defect.Id}:{defect.EscalationCount + 1}:{leader.UserId}",
                        TargetUserId = leader.UserId,
                        Title = $"[团队 Leader] 缺陷催办：{defect.DefectNo}",
                        Message = $"团队成员处理的缺陷 [{defect.Title ?? defect.DefectNo}] 已超时 {elapsedHours} 小时",
                        Level = "error",
                        ActionLabel = "查看详情",
                        ActionUrl = $"/defect-agent?id={defect.Id}",
                        Source = "defect-agent",
                        ExpiresAt = DateTime.UtcNow.AddDays(3)
                    };

                    await db.AdminNotifications.InsertOneAsync(leaderNotification, cancellationToken: CancellationToken.None);
                }
            }

            // 更新催办记录
            var update = Builders<DefectReport>.Update
                .Set(x => x.LastEscalatedAt, now)
                .Inc(x => x.EscalationCount, 1);

            await db.DefectReports.UpdateOneAsync(x => x.Id == defect.Id, update, cancellationToken: CancellationToken.None);

            escalatedCount++;
        }

        if (escalatedCount > 0)
        {
            _logger.LogInformation("[defect-agent] Escalation check complete: {Count} defects escalated", escalatedCount);
        }
    }
}
