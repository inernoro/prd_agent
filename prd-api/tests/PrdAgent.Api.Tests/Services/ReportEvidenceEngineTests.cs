using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services.ReportAgent;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ReportEvidenceEngineTests
{
    private static ReportEvidenceEvent Event(string id, string day, string kind, string? revision = "v1", string? scope = null, string? environment = null) => new()
    {
        Id = id, WorkItemId = "feature", Kind = kind, Revision = revision, Scope = scope, Environment = environment,
        OccurredAt = DateTimeOffset.Parse(day + "T10:00:00+08:00"), Source = new() { Uri = "https://example.test/evidence/" + id, Excerpt = kind }
    };
    private static ReportEvidenceLedger Ledger(params ReportEvidenceEvent[] events) => new()
    { HistoryComplete = true, WorkItems = new() { new() { Id = "feature", Title = "批量导出" } }, Events = events.ToList() };
    private static ReportDeliverySnapshot Build(ReportEvidenceLedger ledger, string start, string end)
        => ReportEvidenceEngine.Build(ledger, DateTime.Parse(start), DateTime.Parse(end));

    [Fact]
    public void SeveralCommitsAndMergeAreOneTrackedItemWithoutClaimingCompletion()
    {
        var data = Ledger(Event("one", "2026-01-30", "commit"), Event("two", "2026-01-31", "commit", "v2"), Event("merge", "2026-02-01", "merged", "v2"));
        var report = Build(data, "2026-01-26", "2026-02-01");
        var item = Assert.Single(report.Items);
        Assert.Equal("in_progress", item.CodeStatus);
        Assert.Equal("unknown", item.ValidationStatus);
        Assert.Equal("unknown", item.ReleaseStatus);
        Assert.All(report.NewMilestones.Values, value => Assert.Equal(0, value));
    }

    [Fact]
    public void CompletionValidationAndReleaseBelongToTheirActualMonthAndNeverRecount()
    {
        var data = Ledger(Event("code", "2026-01-31", "code_complete"), Event("test", "2026-02-01", "validation_passed", scope: "feature"),
            Event("release", "2026-03-01", "release_succeeded", environment: "production"));
        var february = Build(data, "2026-02-01", "2026-02-28");
        Assert.Equal(0, february.NewMilestones["code"]);
        Assert.Equal(1, february.NewMilestones["validation"]);
        Assert.Equal(0, february.NewMilestones["release"]);
        var march = Build(data, "2026-03-01", "2026-03-31");
        Assert.Equal(0, march.NewMilestones["code"]);
        Assert.Equal(0, march.NewMilestones["validation"]);
        Assert.Equal(1, march.NewMilestones["release"]);
        Assert.Empty(Build(data, "2026-04-01", "2026-04-30").Items);
    }

    [Fact]
    public void ANewRevisionInvalidatesOldValidationAndOldRelease()
    {
        var data = Ledger(Event("code", "2026-01-30", "code_complete"), Event("test", "2026-01-31", "validation_passed", scope: "feature"),
            Event("release", "2026-02-01", "release_succeeded", environment: "production"), Event("fix", "2026-02-02", "commit", "v2"));
        var item = Assert.Single(Build(data, "2026-02-01", "2026-02-28").Items);
        Assert.Equal("stale", item.ValidationStatus);
        Assert.Equal("unknown", item.ReleaseStatus);
        Assert.Equal("v2", item.Revision);
    }

    [Fact]
    public void CiAndPreviewCannotBecomeFeatureValidationOrProductionRelease()
    {
        var data = Ledger(Event("code", "2026-02-01", "code_complete"), Event("ci", "2026-02-02", "validation_passed", scope: "ci"),
            Event("preview", "2026-02-03", "release_succeeded", environment: "preview"));
        var item = Assert.Single(Build(data, "2026-02-01", "2026-02-28").Items);
        Assert.Equal("unknown", item.ValidationStatus);
        Assert.Equal("unknown", item.ReleaseStatus);
    }

    [Fact]
    public void FailedCiIsVisibleAsRiskWithoutClaimingFeatureValidation()
    {
        var data = Ledger(Event("code", "2026-02-01", "code_complete"), Event("ci", "2026-02-02", "validation_failed", scope: "ci"));
        var snapshot = Build(data,"2026-02-01","2026-02-28");
        var item = Assert.Single(snapshot.Items);
        Assert.Equal("unknown",item.ValidationStatus);
        Assert.Contains("CI 测试失败",item.BlockReason);
        var singleColumn = ReportEvidenceEngine.BuildSections(new() { Sections = new() { new() { Title = "工作记录" } } },snapshot);
        Assert.Contains("CI 测试失败",Assert.Single(Assert.Single(singleColumn).Items).Content);
    }

    [Fact]
    public void CompletingAnOlderTodoIsVisibleTodayButNotCountedAsFeatureCompletionOrActualHours()
    {
        var activity = new CollectedActivity { DailyLogs = new() { new() { Id = "old-plan",Date = new DateTime(2026,1,30),Items = new() { new()
            { Content = "完成老计划 https://github.com/example/repo/issues/42",Category = DailyLogCategory.Todo,CreatedAt = new DateTime(2026,1,30),CompletedAt = new DateTime(2026,2,2,2,0,0,DateTimeKind.Utc),DurationMinutes = 120 } } } } };
        var snapshot = Build(ReportEvidenceService.FromActivity(activity),"2026-02-02","2026-02-02");
        Assert.Single(snapshot.Items);
        Assert.Equal("in_progress",snapshot.Items[0].CodeStatus);
        Assert.False(snapshot.Metrics.Single(m => m.Key == "hours").Available);
    }

    [Fact]
    public void FailedTestsAndExternalBlockRemainVisibleOnDaysWithoutCommits()
    {
        var blocked = Event("block", "2026-02-02", "blocked", null); blocked.Reason = "需要外部供应商提供凭据";
        var data = Ledger(Event("code", "2026-02-01", "code_complete"), Event("test", "2026-02-02", "validation_failed", scope: "feature"), blocked);
        var item = Assert.Single(Build(data, "2026-02-20", "2026-02-20").Items);
        Assert.Equal("failed", item.ValidationStatus);
        Assert.Equal("需要外部供应商提供凭据", item.BlockReason);
        Assert.Contains("本期无新证据", item.Movement);
        Assert.Equal(3, item.Sources.Count);
    }

    [Fact]
    public void NoCurrentRevisionMatchMeansNoCurrentVerification()
    {
        var data = Ledger(Event("code", "2026-02-01", "code_complete", "v2"), Event("old-test", "2026-02-02", "validation_passed", "v1", scope: "feature"));
        Assert.Equal("unknown", Assert.Single(Build(data,"2026-02-01","2026-02-28").Items).ValidationStatus);
    }

    [Fact]
    public void ShanghaiMidnightIsExclusiveAtTheEndAndFutureEvidenceDoesNotLeak()
    {
        var e = Event("boundary", "2026-02-01", "code_complete"); e.OccurredAt = DateTimeOffset.Parse("2026-02-01T16:00:00Z");
        Assert.Empty(Build(Ledger(e),"2026-02-01","2026-02-01").Items);
        Assert.Single(Build(Ledger(e),"2026-02-02","2026-02-02").Items);
    }

    [Fact]
    public void RepeatedSourceRowsDeduplicateButConflictsFailClosed()
    {
        var e = Event("same", "2026-02-01", "code_complete");
        Assert.Single(ReportEvidenceEngine.Merge(new[] { Ledger(e), Ledger(e) }).Events);
        var conflict = Event("same", "2026-02-01", "commit");
        Assert.Throws<InvalidOperationException>(() => ReportEvidenceEngine.Merge(new[] { Ledger(e), Ledger(conflict) }));
    }

    [Fact]
    public void MissingHistoryAndLateArchivesCannotManufactureNewOutcomes()
    {
        var observed = Event("archive", "2026-02-01", "validation_passed", scope: "feature"); observed.TimeBasis = "observed";
        var data = Ledger(observed);
        Assert.Equal(0, Build(data,"2026-02-01","2026-02-28").NewMilestones["validation"]);
        data.HistoryComplete = false;
        Assert.All(Build(data,"2026-02-01","2026-02-28").NewMilestones.Values, value => Assert.Null(value));
    }

    [Fact]
    public void ModelOutputCannotInsertUnknownItemsStatusesOrInventedBenefits()
    {
        var snapshot = Build(Ledger(Event("code","2026-02-01","code_complete")),"2026-02-01","2026-02-28");
        var order = ReportEvidenceService.ParseProposedOrder("{\"workItemOrder\":[\"fake\",\"feature\",\"feature\"],\"sections\":[{\"content\":\"已上线，收益100万元\"}]}", snapshot).ToList();
        Assert.Equal(new[] { "feature" }, order);
        var sections = ReportEvidenceEngine.BuildSections(new() { Sections = new() { new() { Title = "本周工作" } } },snapshot,order);
        Assert.DoesNotContain("收益100万元", Assert.Single(Assert.Single(sections).Items).Content);
        Assert.Contains("上线未证实", sections[0].Items[0].Content);
    }

    [Fact]
    public void BehaviorCountsAloneDoNotBecomeWorkOnPlanOrNoRisks()
    {
        var activity = new CollectedActivity { ImageGenCompletedCount = 10, WebPagePublishCount = 8, LlmCalls = 10 };
        var snapshot = Build(ReportEvidenceService.FromActivity(activity),"2026-10-05","2026-10-11");
        var template = new ReportTemplate { Sections = new() { new() { Title = "本周工作" },new() { Title = "风险与阻塞" },new() { Title = "下周计划" },new() { Title = "本人评价",SectionType = ReportSectionType.ManualList } } };
        var sections = ReportEvidenceEngine.BuildSections(template,snapshot);
        Assert.DoesNotContain(sections.SelectMany(s => s.Items),i => i.Content.Contains("按计划推进") || i.Content.Contains("未发现明显阻塞"));
        Assert.Empty(sections[2].Items);
        Assert.Empty(sections[3].Items);
        Assert.All(snapshot.Metrics, m => Assert.False(m.Available));
    }

    [Fact]
    public void RegisteredMinutesAreCitedButNeverPresentedAsElapsedActualHours()
    {
        var activity = new CollectedActivity { DailyLogs = new() { new() { Id = "day", Date = new DateTime(2026,2,1), Items = new() { new() { Content = "需求评审",DurationMinutes = 45 } } } } };
        var snapshot = Build(ReportEvidenceService.FromActivity(activity),"2026-02-01","2026-02-01");
        var metric = Assert.Single(snapshot.Metrics.Where(m => m.Key == "hours"));
        Assert.True(metric.Available);
        Assert.Contains("45 分钟",metric.Text);
        Assert.Contains("不是实际总工时",metric.Text);
        Assert.Single(metric.Sources);
        Assert.False(snapshot.Metrics.First(m => m.Key == "efficiency").Available);
    }

    [Fact]
    public void ExplicitTaskLinksAcrossDaysShareIdentityButSimilarTitlesDoNot()
    {
        var activity = new CollectedActivity { DailyLogs = new()
        {
            new() { Id = "one",Date = new DateTime(2026,2,1),Items = new() { new() { Content = "设计 https://github.com/example/repo/issues/42" } } },
            new() { Id = "two",Date = new DateTime(2026,2,2),Items = new() { new() { Content = "修复 https://github.com/example/repo/issues/42" },new() { Content = "设计另一个功能" } } }
        } };
        var snapshot = Build(ReportEvidenceService.FromActivity(activity),"2026-02-01","2026-02-28");
        Assert.Single(snapshot.Items);
        Assert.Equal(1,snapshot.UnassignedEvidenceCount);
        Assert.Equal(2,snapshot.Items[0].Sources.Count);
    }
}
