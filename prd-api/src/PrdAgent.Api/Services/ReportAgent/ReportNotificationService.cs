using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 周报通知服务 — 封装 7 种通知事件，复用 AdminNotification 模型
/// </summary>
public class ReportNotificationService
{
    private readonly MongoDbContext _db;
    private readonly ILogger<ReportNotificationService> _logger;
    private const string Source = "report-agent";
    private const string ActionUrl = "/report-agent";

    public ReportNotificationService(MongoDbContext db, ILogger<ReportNotificationService> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>AI 草稿已生成</summary>
    public async Task NotifyDraftGeneratedAsync(string userId, string reportId, int weekYear, int weekNumber)
    {
        await UpsertNotificationAsync(
            key: $"report-agent:draft:{reportId}",
            targetUserId: userId,
            title: "周报草稿已生成",
            message: $"{weekYear} 年第 {weekNumber} 周的周报草稿已自动生成，请审核提交。",
            level: "info",
            actionLabel: "查看周报");
    }

    /// <summary>截止提醒（未提交员工）</summary>
    public async Task NotifyDeadlineApproachingAsync(string userId, int weekYear, int weekNumber)
    {
        await UpsertNotificationAsync(
            key: $"report-agent:deadline:{userId}:{weekYear}-{weekNumber}",
            targetUserId: userId,
            title: "周报提交提醒",
            message: $"{weekYear} 年第 {weekNumber} 周的周报即将截止，请尽快提交。",
            level: "warning",
            actionLabel: "去提交");
    }

    /// <summary>逾期通知（员工 + 负责人）</summary>
    public async Task NotifyOverdueAsync(string userId, string? leaderUserId, int weekYear, int weekNumber)
    {
        // 通知员工
        await UpsertNotificationAsync(
            key: $"report-agent:overdue:{userId}:{weekYear}-{weekNumber}",
            targetUserId: userId,
            title: "周报已逾期",
            message: $"{weekYear} 年第 {weekNumber} 周的周报已逾期，请尽快补交。",
            level: "error",
            actionLabel: "去补交");

        // 通知负责人
        if (!string.IsNullOrEmpty(leaderUserId))
        {
            await UpsertNotificationAsync(
                key: $"report-agent:overdue-leader:{userId}:{weekYear}-{weekNumber}",
                targetUserId: leaderUserId,
                title: "团队成员周报逾期",
                message: $"有成员的 {weekYear} 年第 {weekNumber} 周周报已逾期未提交。",
                level: "warning",
                actionLabel: "查看团队");
        }
    }

    /// <summary>周报已提交（通知负责人）</summary>
    public async Task NotifyReportSubmittedAsync(WeeklyReport report, string? leaderUserId)
    {
        if (string.IsNullOrEmpty(leaderUserId)) return;

        await UpsertNotificationAsync(
            key: $"report-agent:submitted:{report.Id}",
            targetUserId: leaderUserId,
            title: "收到新周报",
            message: $"{report.UserName ?? "团队成员"} 提交了 {report.WeekYear} 年第 {report.WeekNumber} 周的周报。",
            level: "info",
            actionLabel: "去审阅");
    }

    /// <summary>全员已提交（通知负责人）</summary>
    public async Task NotifyAllSubmittedAsync(string teamId, string teamName, string leaderUserId, int weekYear, int weekNumber)
    {
        await UpsertNotificationAsync(
            key: $"report-agent:all-submitted:{teamId}:{weekYear}-{weekNumber}",
            targetUserId: leaderUserId,
            title: "团队周报已全部提交",
            message: $"{teamName} 团队 {weekYear} 年第 {weekNumber} 周的周报已全部提交。",
            level: "success",
            actionLabel: "查看汇总");
    }

    /// <summary>周报被退回（通知员工）</summary>
    public async Task NotifyReportReturnedAsync(WeeklyReport report, string returnerName)
    {
        // 清除旧的"已提交"通知，以便重新提交时能再次通知负责人
        await _db.AdminNotifications.DeleteOneAsync(
            n => n.Key == $"report-agent:submitted:{report.Id}",
            cancellationToken: CancellationToken.None);

        await UpsertNotificationAsync(
            key: $"report-agent:returned:{report.Id}",
            targetUserId: report.UserId,
            title: "周报被退回",
            message: $"{returnerName} 退回了你的 {report.WeekYear} 年第 {report.WeekNumber} 周周报" +
                     (string.IsNullOrEmpty(report.ReturnReason) ? "。" : $"：{report.ReturnReason}"),
            level: "warning",
            actionLabel: "去修改");
    }

    /// <summary>周报已审阅（通知员工）</summary>
    public async Task NotifyReportReviewedAsync(WeeklyReport report, string reviewerName)
    {
        await UpsertNotificationAsync(
            key: $"report-agent:reviewed:{report.Id}",
            targetUserId: report.UserId,
            title: "周报已审阅",
            message: $"{reviewerName} 已审阅你的 {report.WeekYear} 年第 {report.WeekNumber} 周周报。",
            level: "success",
            actionLabel: "查看详情");
    }

    /// <summary>
    /// 检查团队是否全员已提交（Submitted 或更高状态）
    /// </summary>
    public async Task CheckAndNotifyAllSubmittedAsync(WeeklyReport report)
    {
        var team = await _db.ReportTeams.Find(t => t.Id == report.TeamId).FirstOrDefaultAsync();
        if (team == null) return;

        var members = await _db.ReportTeamMembers.Find(m => m.TeamId == report.TeamId).ToListAsync();
        var memberIds = members.Select(m => m.UserId).ToHashSet();

        var submittedStatuses = new[] { WeeklyReportStatus.Submitted, WeeklyReportStatus.Reviewed };
        var submittedReports = await _db.WeeklyReports.Find(
            r => r.TeamId == report.TeamId
                 && r.WeekYear == report.WeekYear
                 && r.WeekNumber == report.WeekNumber
                 && submittedStatuses.Contains(r.Status)
        ).ToListAsync();

        var submittedUserIds = submittedReports.Select(r => r.UserId).ToHashSet();
        if (memberIds.All(id => submittedUserIds.Contains(id)))
        {
            await NotifyAllSubmittedAsync(
                report.TeamId, team.Name ?? "未命名团队",
                team.LeaderUserId, report.WeekYear, report.WeekNumber);
        }
    }

    private async Task UpsertNotificationAsync(
        string key, string targetUserId, string title, string message,
        string level, string actionLabel)
    {
        // 幂等：如果 Key 已存在则跳过
        var exists = await _db.AdminNotifications.Find(n => n.Key == key).AnyAsync();
        if (exists) return;

        var notification = new AdminNotification
        {
            Key = key,
            TargetUserId = targetUserId,
            Title = title,
            Message = message,
            Level = level,
            Source = Source,
            ActionLabel = actionLabel,
            ActionUrl = ActionUrl,
            ExpiresAt = DateTime.UtcNow.AddDays(14)
        };

        await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: CancellationToken.None);
        _logger.LogDebug("Notification sent: key={Key}, target={Target}", key, targetUserId);
    }
}
