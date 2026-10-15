using PrdAgent.Core.Models;
using PrdAgent.Core.Services.ReportAgent;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>月报纯规则：周归属、可写月份、保存/提交校验、可关联周报。</summary>
public sealed class MonthlyReportRulesTests
{
    [Theory]
    // 2026-W40：周一 9/28，周四 10/1 → 归 10 月（周一在 9 月也不影响）
    [InlineData(2026, 40, 2026, 10)]
    // 2026-W44：周一 10/26，周四 10/29 → 归 10 月（周日 11/1 在 11 月也不影响）
    [InlineData(2026, 44, 2026, 10)]
    // 2026-W45：周一 11/2 → 归 11 月
    [InlineData(2026, 45, 2026, 11)]
    // 2026-W53：周一 12/28，周四 12/31 → 归 2026 年 12 月
    [InlineData(2026, 53, 2026, 12)]
    // 2027-W01：周一 2027/1/4 → 归 2027 年 1 月
    [InlineData(2027, 1, 2027, 1)]
    // 2025-W01：周一 2024/12/30，周四 2025/1/2 → 归 2025 年 1 月（周一在上一年也不影响）
    [InlineData(2025, 1, 2025, 1)]
    public void GetAttributedMonth_UsesThursdayOfIsoWeek(int weekYear, int weekNumber, int year, int month)
    {
        Assert.Equal((year, month), MonthlyReportRules.GetAttributedMonth(weekYear, weekNumber));
    }

    [Fact]
    public void EveryWeekOfAYear_BelongsToExactlyOneMonth()
    {
        // 每一周恰好归属一个月：把 2026 年全部 ISO 周归属后，12 个月的周数之和等于全年周数，且无月份为 0
        var weeks = System.Globalization.ISOWeek.GetWeeksInYear(2026);
        var counts = new int[13];
        for (var w = 1; w <= weeks; w++)
        {
            var (y, m) = MonthlyReportRules.GetAttributedMonth(2026, w);
            Assert.Equal(2026, y);
            counts[m]++;
        }
        Assert.Equal(weeks, counts.Sum());
        for (var m = 1; m <= 12; m++)
            Assert.InRange(counts[m], 4, 5);
    }

    [Theory]
    [InlineData(2026, 10, true)]
    [InlineData(2026, 9, true)]
    [InlineData(2025, 12, true)]
    [InlineData(2026, 11, false)]
    [InlineData(2027, 1, false)]
    [InlineData(2026, 0, false)]
    [InlineData(2026, 13, false)]
    public void IsMonthAllowed_RejectsFutureAndInvalidMonths(int year, int month, bool expected)
    {
        var now = new DateTime(2026, 10, 15, 4, 0, 0, DateTimeKind.Utc);
        Assert.Equal(expected, MonthlyReportRules.IsMonthAllowed(year, month, now));
    }

    [Fact]
    public void IsMonthAllowed_UsesChinaTime_AtMonthBoundary()
    {
        // UTC 10/31 17:00 = 北京时间 11/1 01:00，此时已经可以写 11 月月报
        var now = new DateTime(2026, 10, 31, 17, 0, 0, DateTimeKind.Utc);
        Assert.True(MonthlyReportRules.IsMonthAllowed(2026, 11, now));
    }

    [Theory]
    [InlineData("u1", "t1", WeeklyReportStatus.Submitted, true)]
    [InlineData("u1", "t1", WeeklyReportStatus.Reviewed, true)]
    [InlineData("u1", "t1", WeeklyReportStatus.Viewed, true)]
    [InlineData("u1", "t1", WeeklyReportStatus.Draft, false)]
    [InlineData("u1", "t1", WeeklyReportStatus.NotStarted, false)]
    [InlineData("u2", "t1", WeeklyReportStatus.Submitted, false)]
    [InlineData("u1", "t2", WeeklyReportStatus.Submitted, false)]
    public void IsLinkableWeekly_OnlyOwnSameTeamNonDraft(string owner, string team, string status, bool expected)
    {
        var weekly = new WeeklyReport { UserId = owner, TeamId = team, Status = status };
        Assert.Equal(expected, MonthlyReportRules.IsLinkableWeekly(weekly, "u1", "t1"));
    }

    private static MonthlyReport CompleteReport() => new()
    {
        UserId = "me",
        TeamId = "t1",
        WeeklyLinks = { new MonthlyReportWeeklyLink { WeeklyReportId = "w1" } },
        Partners =
        {
            new MonthlyReportPartner { UserId = "a", Reason = "帮我顶了上线" },
            new MonthlyReportPartner { UserId = "b", Reason = "评审很细" },
            new MonthlyReportPartner { UserId = "c", Reason = "带新人" },
        },
    };

    [Fact]
    public void ValidateForSubmit_CompleteReport_HasNoIssues()
    {
        Assert.Empty(MonthlyReportRules.ValidateForSubmit(CompleteReport()));
    }

    [Fact]
    public void ValidateForSubmit_AcceptsTextOnlyAchievements()
    {
        var r = CompleteReport();
        r.WeeklyLinks.Clear();
        r.AchievementsText = "本月完成了月报功能";
        Assert.Empty(MonthlyReportRules.ValidateForSubmit(r));
    }

    [Fact]
    public void ValidateForSubmit_RejectsEmptyFirstChapter()
    {
        var r = CompleteReport();
        r.WeeklyLinks.Clear();
        r.AchievementsText = "   ";
        var issues = MonthlyReportRules.ValidateForSubmit(r);
        Assert.Contains(issues, i => i.Chapter == MonthlyReportChapters.Achievements);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    public void ValidateForSubmit_RequiresExactlyThreePartners(int count)
    {
        var r = CompleteReport();
        r.Partners = r.Partners.Take(count).ToList();
        Assert.Contains(MonthlyReportRules.ValidateForSubmit(r), i => i.Chapter == MonthlyReportChapters.Partners);
    }

    [Fact]
    public void ValidateForSubmit_RequiresReasonForEachPartner()
    {
        var r = CompleteReport();
        r.Partners[1].Reason = " ";
        Assert.Contains(MonthlyReportRules.ValidateForSubmit(r), i => i.Chapter == MonthlyReportChapters.Partners);
    }

    [Fact]
    public void ValidateForSave_RejectsSelfAsPartner_EvenInDraft()
    {
        var r = new MonthlyReport { UserId = "me", Partners = { new MonthlyReportPartner { UserId = "me" } } };
        Assert.Contains(MonthlyReportRules.ValidateForSave(r), i => i.Message.Contains("自己"));
    }

    [Fact]
    public void ValidateForSave_RejectsDuplicatePartners()
    {
        var r = new MonthlyReport
        {
            UserId = "me",
            Partners = { new MonthlyReportPartner { UserId = "a" }, new MonthlyReportPartner { UserId = "a" } },
        };
        Assert.Contains(MonthlyReportRules.ValidateForSave(r), i => i.Message.Contains("重复"));
    }

    [Fact]
    public void ValidateForSave_RejectsMoreThanThreePartners()
    {
        var r = CompleteReport();
        r.Partners.Add(new MonthlyReportPartner { UserId = "d", Reason = "x" });
        Assert.Contains(MonthlyReportRules.ValidateForSave(r), i => i.Chapter == MonthlyReportChapters.Partners);
    }

    [Fact]
    public void ValidateForSave_AllowsIncompleteDraft()
    {
        var r = new MonthlyReport { UserId = "me", Partners = { new MonthlyReportPartner { UserId = "a" } } };
        Assert.Empty(MonthlyReportRules.ValidateForSave(r));
    }

    [Fact]
    public void ValidateForSave_RejectsDuplicateWeeklyLinks()
    {
        var r = CompleteReport();
        r.WeeklyLinks.Add(new MonthlyReportWeeklyLink { WeeklyReportId = "w1" });
        Assert.Contains(MonthlyReportRules.ValidateForSave(r), i => i.Chapter == MonthlyReportChapters.Achievements);
    }
}

/// <summary>周报互动 / 月报查看的访问矩阵（唯一判定源 ReportAccessPolicy）。</summary>
public sealed class ReportAccessPolicyTests
{
    private static readonly ReportViewer Owner = new(true, ReportTeamRole.Member, false);
    private static readonly ReportViewer Leader = new(false, ReportTeamRole.Leader, false);
    private static readonly ReportViewer Deputy = new(false, ReportTeamRole.Deputy, false);
    private static readonly ReportViewer Member = new(false, ReportTeamRole.Member, false);
    private static readonly ReportViewer ViewAll = new(false, null, true);
    private static readonly ReportViewer Outsider = new(false, null, false);

    public static IEnumerable<object[]> MonthlyMatrix()
    {
        const string all = ReportVisibilityMode.AllMembers;
        const string leaders = ReportVisibilityMode.LeadersOnly;
        foreach (var vis in new[] { all, leaders })
        {
            // 草稿：只有作者
            yield return new object[] { "owner", vis, MonthlyReportStatus.Draft, true };
            yield return new object[] { "leader", vis, MonthlyReportStatus.Draft, false };
            yield return new object[] { "deputy", vis, MonthlyReportStatus.Draft, false };
            yield return new object[] { "member", vis, MonthlyReportStatus.Draft, false };
            yield return new object[] { "viewall", vis, MonthlyReportStatus.Draft, false };
            yield return new object[] { "outsider", vis, MonthlyReportStatus.Draft, false };

            foreach (var status in new[] { MonthlyReportStatus.Submitted, MonthlyReportStatus.Viewed })
            {
                yield return new object[] { "owner", vis, status, true };
                yield return new object[] { "leader", vis, status, true };
                yield return new object[] { "deputy", vis, status, true };
                yield return new object[] { "viewall", vis, status, true };
                yield return new object[] { "outsider", vis, status, false };
                // 普通成员只在「团队成员可互相查看」时可见
                yield return new object[] { "member", vis, status, vis == all };
            }
        }
    }

    private static ReportViewer Pick(string who) => who switch
    {
        "owner" => Owner,
        "leader" => Leader,
        "deputy" => Deputy,
        "member" => Member,
        "viewall" => ViewAll,
        _ => Outsider,
    };

    [Theory]
    [MemberData(nameof(MonthlyMatrix))]
    public void CanViewMonthly_Matrix(string who, string visibility, string status, bool expected)
    {
        Assert.Equal(expected, ReportAccessPolicy.CanViewMonthly(Pick(who), visibility, status));
    }

    [Fact]
    public void CanViewMonthly_MissingVisibility_DefaultsToAllMembers()
    {
        Assert.True(ReportAccessPolicy.CanViewMonthly(Member, null, MonthlyReportStatus.Submitted));
    }

    [Theory]
    [InlineData("owner", ReportVisibilityMode.LeadersOnly, true)]
    [InlineData("leader", ReportVisibilityMode.LeadersOnly, true)]
    [InlineData("deputy", ReportVisibilityMode.LeadersOnly, true)]
    [InlineData("viewall", ReportVisibilityMode.LeadersOnly, true)]
    // 修复前普通成员可以读写「仅负责人可查看」团队里别人周报的评论 / 点赞 / 浏览
    [InlineData("member", ReportVisibilityMode.LeadersOnly, false)]
    [InlineData("outsider", ReportVisibilityMode.LeadersOnly, false)]
    [InlineData("member", ReportVisibilityMode.AllMembers, true)]
    [InlineData("outsider", ReportVisibilityMode.AllMembers, false)]
    public void CanInteractWithWeekly_RespectsLeadersOnly(string who, string visibility, bool expected)
    {
        Assert.Equal(expected, ReportAccessPolicy.CanInteractWithWeekly(Pick(who), visibility));
    }
}
