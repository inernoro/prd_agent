using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services.ReportAgent;

/// <summary>
/// 周报提交统计的纯规则（应交 / 已提交 / 待提交 / 超时），团队周报视图与分享页共用同一口径。
///
/// 口径：
/// - 应交 = 团队全部成员剔除「免提交」（负责人默认免提交 + 管理员设为免提交）；请假状态不影响应交。
/// - 已提交 = 应交成员中当前处于 submitted / reviewed / viewed 的周报数。
/// - 待提交 = 应交 - 已提交，可归 0。
/// - 超时 = 已过截止，且该应交成员在截止前没有完成首次提交（含截止后才补交的人）；
///   是历史事实，不随补交归 0。被退回后再提交不影响判定，只看首次提交时间。
/// </summary>
public static class WeeklyReportSubmissionRules
{
    private static readonly TimeZoneInfo ChinaTimeZone = TimeZoneInfo.FindSystemTimeZoneById("Asia/Shanghai");

    /// <summary>
    /// 统一截止规则生效周（含）：从这一周起，全部团队的截止时间 = 该周结束后的周一 24:00（UTC+8），
    /// 不再读团队自己的 WeeklyDeadline。之前的周「既往不咎」，仍按团队当时的设置判定。
    /// 上线时正在进行中的那一周即按新规则。
    /// </summary>
    public const int UnifiedDeadlineEffectiveWeekYear = 2026;
    public const int UnifiedDeadlineEffectiveWeekNumber = 46;

    /// <summary>该周是否已适用统一截止规则（周一 24:00）。</summary>
    public static bool UsesUnifiedDeadline(int weekYear, int weekNumber)
        => weekYear > UnifiedDeadlineEffectiveWeekYear
           || (weekYear == UnifiedDeadlineEffectiveWeekYear && weekNumber >= UnifiedDeadlineEffectiveWeekNumber);

    /// <summary>
    /// 某 ISO 周的提交截止时间（UTC）。
    /// 生效周及之后：该周结束后的周一 24:00（即周二 00:00，UTC+8）前。
    /// 生效周之前：按团队 WeeklyDeadline（如 "sunday-23:59"，UTC+8，星期取本周内），缺失或非法回退 sunday-23:59。
    /// </summary>
    public static DateTime ResolveWeekDeadline(int weekYear, int weekNumber, string? teamSchedule)
    {
        var monday = System.Globalization.ISOWeek.ToDateTime(weekYear, weekNumber, DayOfWeek.Monday);
        if (UsesUnifiedDeadline(weekYear, weekNumber))
        {
            // 下周一 24:00 = 下周二 00:00（本地），截止判定是「严格晚于才算超时」
            var unifiedLocal = DateTime.SpecifyKind(monday.Date.AddDays(8), DateTimeKind.Unspecified);
            return TimeZoneInfo.ConvertTimeToUtc(unifiedLocal, ChinaTimeZone);
        }
        return ResolveLegacyTeamDeadline(monday, teamSchedule);
    }

    private static DateTime ResolveLegacyTeamDeadline(DateTime monday, string? schedule)
    {
        int dayOffset = 6;
        int hour = 23;
        int minute = 59;
        if (!string.IsNullOrWhiteSpace(schedule))
        {
            var parts = schedule.Split('-', 2);
            if (parts.Length == 2)
            {
                dayOffset = parts[0].Trim().ToLowerInvariant() switch
                {
                    "monday" => 0,
                    "tuesday" => 1,
                    "wednesday" => 2,
                    "thursday" => 3,
                    "friday" => 4,
                    "saturday" => 5,
                    "sunday" => 6,
                    _ => 6,
                };
                if (TimeSpan.TryParse(parts[1].Trim(), out var ts))
                {
                    hour = ts.Hours;
                    minute = ts.Minutes;
                }
            }
        }
        var deadlineLocal = DateTime.SpecifyKind(
            monday.Date.AddDays(dayOffset).AddHours(hour).AddMinutes(minute).AddSeconds(59),
            DateTimeKind.Unspecified);
        return TimeZoneInfo.ConvertTimeToUtc(deadlineLocal, ChinaTimeZone);
    }

    /// <summary>算作「已提交」的周报状态。</summary>
    public static readonly IReadOnlySet<string> SubmittedStatuses = new HashSet<string>
    {
        WeeklyReportStatus.Submitted,
        WeeklyReportStatus.Reviewed,
        WeeklyReportStatus.Viewed,
    };

    /// <summary>免提交成员：负责人默认免提交，或被管理员设为免提交。</summary>
    public static bool IsExempt(ReportTeamMember member)
        => member.Role == ReportTeamRole.Leader || member.IsExcused;

    /// <summary>
    /// 首次提交时间。新数据读 <see cref="WeeklyReport.FirstSubmittedAt"/>；
    /// 旧数据没有该字段，依次回退到版本历史里最早一次 submitted 事件、再回退到 SubmittedAt。
    /// </summary>
    public static DateTime? GetFirstSubmittedAt(WeeklyReport? report)
    {
        if (report == null) return null;
        if (report.FirstSubmittedAt.HasValue) return report.FirstSubmittedAt;

        DateTime? earliestEvent = null;
        if (report.VersionHistory != null)
        {
            foreach (var e in report.VersionHistory)
            {
                if (e.Event != ReportVersionEvent.Submitted) continue;
                if (earliestEvent == null || e.At < earliestEvent) earliestEvent = e.At;
            }
        }
        if (earliestEvent.HasValue) return earliestEvent;

        return report.SubmittedAt;
    }

    /// <summary>
    /// 该成员本周是否超时：未过截止一律否；过了截止，截止前没有首次提交即为超时（之后补交仍算超时）。
    /// 调用方负责只对应交成员调用。
    /// </summary>
    public static bool IsOverdue(WeeklyReport? report, DateTime deadline, DateTime now)
    {
        if (now <= deadline) return false;
        var first = GetFirstSubmittedAt(report);
        return first == null || first.Value > deadline;
    }

    /// <summary>
    /// 本次提交时应写入的首次提交时间；字段已落库返回 null（不覆盖）。
    /// 旧数据字段缺失时，把回退链推导出的历史首次提交时间固化下来——
    /// 否则本次提交会覆盖 SubmittedAt，旧数据就再也推不出首次提交时间。
    /// </summary>
    public static DateTime? ResolveFirstSubmittedAtToStamp(WeeklyReport report, DateTime now)
    {
        if (report.FirstSubmittedAt.HasValue) return null;
        return GetFirstSubmittedAt(report) ?? now;
    }

    public sealed record Stats(int ExpectedCount, int SubmittedCount, int PendingCount, int OverdueCount);

    /// <summary>按统一口径计算团队某周的提交统计。</summary>
    public static Stats Compute(
        IEnumerable<ReportTeamMember> allMembers,
        IReadOnlyDictionary<string, WeeklyReport> reportByUserId,
        DateTime deadline,
        DateTime now)
    {
        var expected = 0;
        var submitted = 0;
        var overdue = 0;
        foreach (var m in allMembers)
        {
            if (IsExempt(m)) continue;
            expected++;
            reportByUserId.TryGetValue(m.UserId, out var report);
            if (report != null && SubmittedStatuses.Contains(report.Status)) submitted++;
            if (IsOverdue(report, deadline, now)) overdue++;
        }
        return new Stats(expected, submitted, Math.Max(0, expected - submitted), overdue);
    }
}
