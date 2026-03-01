using System.Globalization;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 周报自动生成后台服务 — 每周五 16:00 (UTC+8) 自动为未创建周报的团队成员生成草稿
/// </summary>
public class ReportAutoGenerateWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<ReportAutoGenerateWorker> _logger;
    private static readonly TimeSpan CheckInterval = TimeSpan.FromMinutes(15);
    private static readonly TimeZoneInfo ChinaTimeZone = TimeZoneInfo.FindSystemTimeZoneById("Asia/Shanghai");

    // 记录本周是否已触发过，避免重复执行
    private int _lastTriggeredWeek = -1;
    private int _lastTriggeredYear = -1;

    public ReportAutoGenerateWorker(IServiceScopeFactory scopeFactory, ILogger<ReportAutoGenerateWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    // 截止提醒去重
    private int _lastDeadlineReminderWeek = -1;
    private int _lastDeadlineReminderYear = -1;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("ReportAutoGenerateWorker started");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(CheckInterval, stoppingToken);
                await CheckAndGenerateAsync(stoppingToken);
                await CheckDeadlineAndOverdueAsync();
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "ReportAutoGenerateWorker loop error");
            }
        }

        _logger.LogInformation("ReportAutoGenerateWorker stopped");
    }

    private async Task CheckAndGenerateAsync(CancellationToken ct)
    {
        var chinaTime = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, ChinaTimeZone);

        // MVP: 只在周五 16:00 之后触发
        if (chinaTime.DayOfWeek != DayOfWeek.Friday || chinaTime.Hour < 16)
            return;

        var weekYear = ISOWeek.GetYear(chinaTime);
        var weekNumber = ISOWeek.GetWeekOfYear(chinaTime);

        // 本周已触发过
        if (_lastTriggeredYear == weekYear && _lastTriggeredWeek == weekNumber)
            return;

        _logger.LogInformation("Auto-generating weekly reports for {Year}-W{Week}", weekYear, weekNumber);

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var generationService = scope.ServiceProvider.GetRequiredService<ReportGenerationService>();

        // 获取所有团队
        var teams = await db.ReportTeams.Find(_ => true).ToListAsync(ct);

        var generated = 0;
        var skipped = 0;

        foreach (var team in teams)
        {
            try
            {
                // 获取团队成员
                var members = await db.ReportTeamMembers.Find(m => m.TeamId == team.Id).ToListAsync(ct);

                foreach (var member in members)
                {
                    // 检查是否已有本周周报
                    var existing = await db.WeeklyReports.Find(
                        r => r.UserId == member.UserId && r.TeamId == team.Id
                             && r.WeekYear == weekYear && r.WeekNumber == weekNumber
                    ).AnyAsync(ct);

                    if (existing)
                    {
                        skipped++;
                        continue;
                    }

                    // 查找适用模板：团队+岗位 → 团队通用 → 系统默认
                    var templateId = await FindTemplateAsync(db, team.Id, member.JobTitle, ct);
                    if (templateId == null)
                    {
                        _logger.LogWarning("No template found for team={Team}, jobTitle={Job}", team.Name, member.JobTitle);
                        continue;
                    }

                    try
                    {
                        await generationService.GenerateAsync(
                            member.UserId, team.Id, templateId,
                            weekYear, weekNumber, CancellationToken.None);

                        // 创建通知
                        var notification = new AdminNotification
                        {
                            Key = $"report-auto-gen:{member.UserId}:{weekYear}-W{weekNumber}",
                            TargetUserId = member.UserId,
                            Title = "周报草稿已生成",
                            Message = $"{weekYear} 年第 {weekNumber} 周的周报草稿已自动生成，请审核提交。",
                            Level = "info",
                            Source = "report-agent",
                            ActionLabel = "查看周报",
                            ActionUrl = "/report-agent",
                            ExpiresAt = DateTime.UtcNow.AddDays(7)
                        };

                        // 幂等插入（通过 Key）
                        var existingNotif = await db.AdminNotifications.Find(
                            n => n.Key == notification.Key).AnyAsync(CancellationToken.None);
                        if (!existingNotif)
                        {
                            await db.AdminNotifications.InsertOneAsync(notification, cancellationToken: CancellationToken.None);
                        }

                        generated++;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Auto-generate failed for user={User}, team={Team}",
                            member.UserId, team.Name);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Auto-generate error for team={Team}", team.Name);
            }
        }

        _lastTriggeredYear = weekYear;
        _lastTriggeredWeek = weekNumber;

        _logger.LogInformation("Auto-generate completed: generated={Generated}, skipped={Skipped}", generated, skipped);
    }

    /// <summary>
    /// 检查截止提醒 + 逾期标记
    /// </summary>
    private async Task CheckDeadlineAndOverdueAsync()
    {
        var chinaTime = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, ChinaTimeZone);
        var weekYear = ISOWeek.GetYear(chinaTime);
        var weekNumber = ISOWeek.GetWeekOfYear(chinaTime);

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var notificationService = scope.ServiceProvider.GetRequiredService<ReportNotificationService>();

        // 截止提醒：周五 10:00 或 15:00（每周只提醒一次）
        if (chinaTime.DayOfWeek == DayOfWeek.Friday &&
            (chinaTime.Hour == 10 || chinaTime.Hour == 15) &&
            (_lastDeadlineReminderYear != weekYear || _lastDeadlineReminderWeek != weekNumber))
        {
            _logger.LogInformation("Sending deadline reminders for {Year}-W{Week}", weekYear, weekNumber);
            _lastDeadlineReminderYear = weekYear;
            _lastDeadlineReminderWeek = weekNumber;

            var teams = await db.ReportTeams.Find(_ => true).ToListAsync();
            foreach (var team in teams)
            {
                var members = await db.ReportTeamMembers.Find(m => m.TeamId == team.Id).ToListAsync();
                foreach (var member in members)
                {
                    var hasReport = await db.WeeklyReports.Find(
                        r => r.UserId == member.UserId && r.TeamId == team.Id
                             && r.WeekYear == weekYear && r.WeekNumber == weekNumber
                             && (r.Status == WeeklyReportStatus.Submitted || r.Status == WeeklyReportStatus.Reviewed)
                    ).AnyAsync();

                    if (!hasReport)
                    {
                        await notificationService.NotifyDeadlineApproachingAsync(member.UserId, weekYear, weekNumber);
                    }
                }
            }
        }

        // 逾期标记：周一之后，上周的 Draft/NotStarted → Overdue
        if (chinaTime.DayOfWeek == DayOfWeek.Monday && chinaTime.Hour >= 10)
        {
            var prevWeekNumber = weekNumber - 1;
            var prevWeekYear = weekYear;
            if (prevWeekNumber < 1)
            {
                prevWeekYear--;
                prevWeekNumber = ISOWeek.GetWeeksInYear(prevWeekYear);
            }

            var overdueStatuses = new[] { WeeklyReportStatus.Draft, WeeklyReportStatus.NotStarted };
            var overdueReports = await db.WeeklyReports.Find(
                r => r.WeekYear == prevWeekYear && r.WeekNumber == prevWeekNumber
                     && overdueStatuses.Contains(r.Status)
            ).ToListAsync();

            foreach (var report in overdueReports)
            {
                await db.WeeklyReports.UpdateOneAsync(
                    r => r.Id == report.Id,
                    Builders<WeeklyReport>.Update
                        .Set(r => r.Status, WeeklyReportStatus.Overdue)
                        .Set(r => r.UpdatedAt, DateTime.UtcNow));

                var team = await db.ReportTeams.Find(t => t.Id == report.TeamId).FirstOrDefaultAsync();
                await notificationService.NotifyOverdueAsync(
                    report.UserId, team?.LeaderUserId, prevWeekYear, prevWeekNumber);
            }

            if (overdueReports.Count > 0)
                _logger.LogInformation("Marked {Count} reports as overdue for {Year}-W{Week}",
                    overdueReports.Count, prevWeekYear, prevWeekNumber);
        }
    }

    private static async Task<string?> FindTemplateAsync(MongoDbContext db, string teamId, string? jobTitle, CancellationToken ct)
    {
        // 1. 团队+岗位专属模板
        if (!string.IsNullOrEmpty(jobTitle))
        {
            var specific = await db.ReportTemplates.Find(
                t => t.TeamId == teamId && t.JobTitle == jobTitle
            ).FirstOrDefaultAsync(ct);
            if (specific != null) return specific.Id;
        }

        // 2. 团队通用模板
        var teamTemplate = await db.ReportTemplates.Find(
            t => t.TeamId == teamId && t.JobTitle == null
        ).FirstOrDefaultAsync(ct);
        if (teamTemplate != null) return teamTemplate.Id;

        // 3. 系统默认模板
        var defaultTemplate = await db.ReportTemplates.Find(
            t => t.IsDefault
        ).FirstOrDefaultAsync(ct);

        return defaultTemplate?.Id;
    }
}
