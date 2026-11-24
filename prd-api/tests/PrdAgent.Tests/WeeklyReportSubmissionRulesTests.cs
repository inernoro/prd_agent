using PrdAgent.Core.Models;
using PrdAgent.Core.Services.ReportAgent;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>周报提交统计口径：应交 / 已提交 / 待提交 / 超时（超时不随补交归 0）。</summary>
public sealed class WeeklyReportSubmissionRulesTests
{
    private static readonly DateTime Deadline = new(2026, 11, 8, 15, 59, 0, DateTimeKind.Utc);
    private static readonly DateTime AfterDeadline = Deadline.AddDays(2);

    private static ReportTeamMember Member(string id, string role = ReportTeamRole.Member, bool excused = false)
        => new() { UserId = id, Role = role, IsExcused = excused };

    private static WeeklyReport Report(string userId, string status, DateTime? submittedAt = null,
        DateTime? firstSubmittedAt = null, params DateTime[] submittedEvents)
        => new()
        {
            UserId = userId,
            Status = status,
            SubmittedAt = submittedAt,
            FirstSubmittedAt = firstSubmittedAt,
            VersionHistory = submittedEvents
                .Select(at => new ReportVersionEntry { Event = ReportVersionEvent.Submitted, At = at })
                .ToList(),
        };

    [Fact]
    public void LateSubmission_StaysOverdue_WhilePendingDropsToZero()
    {
        var members = new[] { Member("a"), Member("b") };
        var reports = new Dictionary<string, WeeklyReport>
        {
            ["a"] = Report("a", WeeklyReportStatus.Submitted, Deadline.AddHours(-1), Deadline.AddHours(-1)),
            ["b"] = Report("b", WeeklyReportStatus.Submitted, Deadline.AddDays(1), Deadline.AddDays(1)),
        };

        var stats = WeeklyReportSubmissionRules.Compute(members, reports, Deadline, AfterDeadline);

        Assert.Equal(2, stats.ExpectedCount);
        Assert.Equal(2, stats.SubmittedCount);
        Assert.Equal(0, stats.PendingCount);
        Assert.Equal(1, stats.OverdueCount);
    }

    [Fact]
    public void ExpectedCount_ExcludesLeaderAndExcused_ButNotVacation()
    {
        var members = new[]
        {
            Member("leader", ReportTeamRole.Leader),
            Member("deputy", ReportTeamRole.Deputy, excused: true),
            Member("vacation"),
            Member("m"),
        };
        var reports = new Dictionary<string, WeeklyReport>
        {
            ["vacation"] = Report("vacation", WeeklyReportStatus.Vacation),
        };

        var stats = WeeklyReportSubmissionRules.Compute(members, reports, Deadline, AfterDeadline);

        Assert.Equal(2, stats.ExpectedCount);
        Assert.Equal(0, stats.SubmittedCount);
        Assert.Equal(2, stats.PendingCount);
        // 免提交成员不计超时；请假但没交的应交成员照计
        Assert.Equal(2, stats.OverdueCount);
    }

    [Fact]
    public void BeforeDeadline_NothingIsOverdue()
    {
        Assert.False(WeeklyReportSubmissionRules.IsOverdue(null, Deadline, Deadline.AddMinutes(-1)));
    }

    [Fact]
    public void ReturnedThenResubmittedAfterDeadline_NotOverdue_WhenFirstSubmissionWasOnTime()
    {
        var report = Report("a", WeeklyReportStatus.Submitted,
            submittedAt: Deadline.AddDays(1), firstSubmittedAt: Deadline.AddHours(-2));

        Assert.False(WeeklyReportSubmissionRules.IsOverdue(report, Deadline, AfterDeadline));
    }

    [Fact]
    public void LegacyReport_WithoutFirstSubmittedAt_FallsBackToEarliestSubmittedEvent()
    {
        // 旧数据：按时交过 → 被退回 → 截止后重交，SubmittedAt 已被覆盖，只有版本历史还记得首次提交
        var report = Report("a", WeeklyReportStatus.Submitted,
            Deadline.AddDays(1), null,
            Deadline.AddDays(1), Deadline.AddHours(-3));

        Assert.Equal(Deadline.AddHours(-3), WeeklyReportSubmissionRules.GetFirstSubmittedAt(report));
        Assert.False(WeeklyReportSubmissionRules.IsOverdue(report, Deadline, AfterDeadline));
    }

    [Fact]
    public void LegacyReport_WithoutHistory_FallsBackToSubmittedAt()
    {
        var report = Report("a", WeeklyReportStatus.Submitted, submittedAt: Deadline.AddHours(5));

        Assert.True(WeeklyReportSubmissionRules.IsOverdue(report, Deadline, AfterDeadline));
    }

    [Fact]
    public void UnifiedDeadline_FromEffectiveWeek_IsFollowingMondayMidnightChinaTime()
    {
        // 2026-W46 = 11/9(一)~11/15(日)，截止 = 11/16(一) 24:00 UTC+8 = 11/16 16:00 UTC；团队设置被忽略
        var deadline = WeeklyReportSubmissionRules.ResolveWeekDeadline(2026, 46, "friday-12:00");
        Assert.Equal(new DateTime(2026, 11, 16, 16, 0, 0, DateTimeKind.Utc), deadline);

        // 周一 23:59 交：准时；周二 00:01 交：超时
        var onTime = Report("a", WeeklyReportStatus.Submitted, firstSubmittedAt: deadline.AddMinutes(-1));
        var late = Report("b", WeeklyReportStatus.Submitted, firstSubmittedAt: deadline.AddMinutes(1));
        Assert.False(WeeklyReportSubmissionRules.IsOverdue(onTime, deadline, deadline.AddDays(1)));
        Assert.True(WeeklyReportSubmissionRules.IsOverdue(late, deadline, deadline.AddDays(1)));

        // 跨年仍生效
        Assert.True(WeeklyReportSubmissionRules.UsesUnifiedDeadline(2027, 1));
    }

    [Fact]
    public void WeeksBeforeEffectiveWeek_KeepTeamSchedule()
    {
        // 2026-W45 = 11/2~11/8：既往不咎，仍按团队旧设置 sunday-23:59 → 11/8 23:59:59 UTC+8
        Assert.False(WeeklyReportSubmissionRules.UsesUnifiedDeadline(2026, 45));
        Assert.Equal(new DateTime(2026, 11, 8, 15, 59, 59, DateTimeKind.Utc),
            WeeklyReportSubmissionRules.ResolveWeekDeadline(2026, 45, "sunday-23:59"));
        // 缺失设置回退 sunday-23:59
        Assert.Equal(new DateTime(2026, 11, 8, 15, 59, 59, DateTimeKind.Utc),
            WeeklyReportSubmissionRules.ResolveWeekDeadline(2026, 45, null));
    }

    [Fact]
    public void Stamp_WritesOnlyOnce_AndFreezesLegacyFirstSubmission()
    {
        var now = AfterDeadline;
        var fresh = Report("a", WeeklyReportStatus.Draft);
        Assert.Equal(now, WeeklyReportSubmissionRules.ResolveFirstSubmittedAtToStamp(fresh, now));

        var stamped = Report("a", WeeklyReportStatus.Returned, firstSubmittedAt: Deadline.AddHours(-1));
        Assert.Null(WeeklyReportSubmissionRules.ResolveFirstSubmittedAtToStamp(stamped, now));

        var legacy = Report("a", WeeklyReportStatus.Returned, submittedAt: Deadline.AddHours(-4));
        Assert.Equal(Deadline.AddHours(-4), WeeklyReportSubmissionRules.ResolveFirstSubmittedAtToStamp(legacy, now));
    }
}
