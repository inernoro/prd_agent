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
    private readonly ReportWebhookService _webhookService;
    private const string Source = "report-agent";
    private const string ActionUrl = "/report-agent";
    /// <summary>成员身份映射里企业微信 userid 的 key（与前端 IdentityMappingEditor 的平台 key 一致）</summary>
    private const string WeComIdentityKey = "wecom";
    private const int MaxQuoteLength = 100;
    private const int MaxCommentLength = 300;

    public ReportNotificationService(
        MongoDbContext db,
        ILogger<ReportNotificationService> logger,
        ReportWebhookService webhookService)
    {
        _db = db;
        _logger = logger;
        _webhookService = webhookService;
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

    /// <summary>截止提醒（未提交员工）— 需要 teamId 以触发 Webhook</summary>
    public async Task NotifyDeadlineApproachingAsync(string userId, int weekYear, int weekNumber, string? teamId = null, List<string>? pendingMemberNames = null)
    {
        await UpsertNotificationAsync(
            key: $"report-agent:deadline:{userId}:{weekYear}-{weekNumber}",
            targetUserId: userId,
            title: "周报提交提醒",
            message: $"{weekYear} 年第 {weekNumber} 周的周报即将截止，请尽快提交。",
            level: "warning",
            actionLabel: "去提交");

        if (!string.IsNullOrEmpty(teamId) && pendingMemberNames is { Count: > 0 })
        {
            var names = string.Join("、", pendingMemberNames);
            await _webhookService.NotifyAsync(teamId, ReportEventType.DeadlineApproaching,
                "周报截止提醒",
                $"**{weekYear} 年第 {weekNumber} 周**\n以下成员尚未提交周报：{names}",
                ActionUrl);
        }
    }

    /// <summary>逾期通知（员工 + 负责人）</summary>
    public async Task NotifyOverdueAsync(string userId, string? leaderUserId, int weekYear, int weekNumber, string? teamId = null, List<string>? overdueMemberNames = null)
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

        if (!string.IsNullOrEmpty(teamId) && overdueMemberNames is { Count: > 0 })
        {
            var names = string.Join("、", overdueMemberNames);
            await _webhookService.NotifyAsync(teamId, ReportEventType.Overdue,
                "周报已逾期",
                $"**{weekYear} 年第 {weekNumber} 周**\n以下成员周报已逾期：{names}",
                ActionUrl);
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

        await _webhookService.NotifyAsync(report.TeamId, ReportEventType.Submitted,
            "周报已提交",
            $"**{report.UserName ?? "团队成员"}** 提交了 {report.WeekYear} 年第 {report.WeekNumber} 周的周报",
            ActionUrl);
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

        await _webhookService.NotifyAsync(teamId, ReportEventType.AllSubmitted,
            "团队周报已全部提交",
            $"**{teamName}** 团队 {weekYear} 年第 {weekNumber} 周的周报已全部提交，可生成团队汇总。",
            ActionUrl);
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

        var reason = string.IsNullOrEmpty(report.ReturnReason) ? "" : $"\n退回原因：{report.ReturnReason}";
        await _webhookService.NotifyAsync(report.TeamId, ReportEventType.Returned,
            "周报被退回",
            $"**{report.UserName ?? "团队成员"}** 的 {report.WeekYear} 年第 {report.WeekNumber} 周周报被 {returnerName} 退回{reason}",
            ActionUrl);
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

        await _webhookService.NotifyAsync(report.TeamId, ReportEventType.Reviewed,
            "周报已审阅",
            $"**{report.UserName ?? "团队成员"}** 的 {report.WeekYear} 年第 {report.WeekNumber} 周周报已被 {reviewerName} 审阅通过",
            ActionUrl);
    }

    /// <summary>
    /// 评论 @ 提醒：给被 @ 的成员发站内通知，并按团队 Webhook 配置同步推送到群（引用原文 + 评论内容）。
    /// 企微群里能否真的 @ 到人，取决于成员身份映射里有没有配 wecom userid；没配就只发 @显示名 文本。
    /// </summary>
    public async Task NotifyCommentMentionAsync(WeeklyReport report, ReportComment comment)
    {
        var mentionedIds = (comment.MentionedUserIds ?? new List<string>())
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (mentionedIds.Count == 0) return;

        var members = await _db.ReportTeamMembers
            .Find(m => m.TeamId == report.TeamId && mentionedIds.Contains(m.UserId))
            .ToListAsync();

        var users = await _db.Users
            .Find(u => mentionedIds.Contains(u.UserId))
            .ToListAsync();

        var displayNames = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var id in mentionedIds)
        {
            var user = users.FirstOrDefault(u => u.UserId == id);
            var member = members.FirstOrDefault(m => m.UserId == id);
            var name = user?.DisplayName?.Trim();
            if (string.IsNullOrWhiteSpace(name)) name = member?.UserName?.Trim();
            if (string.IsNullOrWhiteSpace(name)) name = user?.Username?.Trim();
            displayNames[id] = string.IsNullOrWhiteSpace(name) ? id : name!;
        }

        var deepLink = $"{ActionUrl}/report/{report.Id}?comment={comment.Id}";
        var weekLabel = $"{report.WeekYear} 年第 {report.WeekNumber} 周";
        var sectionLabel = string.IsNullOrWhiteSpace(comment.SectionTitleSnapshot)
            ? "周报正文"
            : comment.SectionTitleSnapshot;

        // 站内：一人一条，key 带 commentId 保证幂等（同一条评论不会重复打扰）
        foreach (var id in mentionedIds)
        {
            await UpsertNotificationAsync(
                key: $"report-agent:comment-mention:{comment.Id}:{id}",
                targetUserId: id,
                title: "有人在周报评论中 @ 你",
                message: $"{comment.AuthorDisplayName} 在{weekLabel}周报「{sectionLabel}」评论中提到了你：{BuildCommentExcerpt(comment)}",
                level: "info",
                actionLabel: "查看评论",
                actionUrl: deepLink);
        }

        var mentionText = string.Join(" ", mentionedIds.Select(id => $"@{displayNames[id]}"));
        var ownerName = string.IsNullOrWhiteSpace(report.UserName) ? "团队成员" : report.UserName;

        var lines = new List<string>
        {
            $"**{comment.AuthorDisplayName}** 在 **{ownerName}** 的{weekLabel}周报「{sectionLabel}」中提到了 {mentionText}"
        };
        if (!string.IsNullOrWhiteSpace(comment.SelectedText))
            lines.Add($"> 引用：{TruncateForPush(comment.SelectedText, MaxQuoteLength)}");
        lines.Add($"评论：{BuildCommentExcerpt(comment)}");

        // 只有配了 wecom 映射的成员才能被真 @；缺映射的人保持正文里的 @显示名 文本
        var wecomIds = members
            .Select(m => m.IdentityMappings.TryGetValue(WeComIdentityKey, out var wecomId) ? wecomId : null)
            .Where(v => !string.IsNullOrWhiteSpace(v))
            .Select(v => v!.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToList();

        await _webhookService.NotifyAsync(
            report.TeamId,
            ReportEventType.CommentMention,
            "周报评论提醒",
            string.Join("\n", lines),
            deepLink,
            wecomIds);
    }

    /// <summary>评论摘要：纯图片评论没有文字，给出可读占位</summary>
    private static string BuildCommentExcerpt(ReportComment comment)
    {
        var content = comment.Content?.Trim();
        if (string.IsNullOrEmpty(content))
            return comment.AttachmentIds is { Count: > 0 } ? "[图片]" : "";
        return TruncateForPush(content, MaxCommentLength);
    }

    /// <summary>推送文案裁剪：超长正文会把群消息刷屏，也会撑爆 webhook 投递日志</summary>
    private static string TruncateForPush(string? value, int maxLength)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (trimmed.Length <= maxLength) return trimmed;
        return trimmed[..maxLength] + "…";
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
        string level, string actionLabel, string? actionUrl = null)
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
            ActionUrl = string.IsNullOrWhiteSpace(actionUrl) ? ActionUrl : actionUrl,
            ExpiresAt = DateTime.UtcNow.AddDays(14)
        };

        await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: CancellationToken.None);
        _logger.LogDebug("Notification sent: key={Key}, target={Target}", key, targetUserId);
    }
}
