using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class ChangelogLinkedDefectsTests
{
    [Fact]
    public void ResolvePublishStatus_UsesDeployedCommitPosition()
    {
        var shaIndex = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
        {
            ["newer"] = 0,
            ["deployed"] = 1,
            ["older"] = 2,
        };

        Assert.Equal(
            DefectResolutionPublishStatus.Pending,
            ChangelogController.ResolvePublishStatus(
                new DefectResolutionTrace { CommitSha = "newer" },
                "deployed",
                1,
                shaIndex));

        Assert.Equal(
            DefectResolutionPublishStatus.Published,
            ChangelogController.ResolvePublishStatus(
                new DefectResolutionTrace { CommitSha = "older" },
                "deployed",
                1,
                shaIndex));
    }

    [Fact]
    public void ResolvePublishStatus_UsesResolvedCommitShaWhenTraceStoresShortSha()
    {
        var fullSha = "abcdef1234567890abcdef1234567890abcdef12";
        var shaIndex = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
        {
            ["deployed"] = 0,
            [fullSha] = 1,
        };

        Assert.Equal(
            DefectResolutionPublishStatus.Published,
            ChangelogController.ResolvePublishStatus(
                new DefectResolutionTrace { CommitSha = "abcdef1" },
                fullSha,
                "deployed",
                0,
                shaIndex));
    }

    [Fact]
    public void ResolvePublishStatus_KeepsPersistedPublishedStatus()
    {
        var status = ChangelogController.ResolvePublishStatus(
            new DefectResolutionTrace
            {
                CommitSha = "missing",
                PublishStatus = DefectResolutionPublishStatus.Published,
            },
            null,
            -1,
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase));

        Assert.Equal(DefectResolutionPublishStatus.Published, status);
    }

    [Fact]
    public void ResolvePendingReviewPublishStatus_TreatsOpenPrAsPending()
    {
        Assert.Equal(
            DefectResolutionPublishStatus.Pending,
            ChangelogController.ResolvePendingReviewPublishStatus(new DefectResolutionTrace()));

        Assert.Equal(
            DefectResolutionPublishStatus.Published,
            ChangelogController.ResolvePendingReviewPublishStatus(new DefectResolutionTrace
            {
                PublishStatus = DefectResolutionPublishStatus.Published,
            }));
    }

    [Fact]
    public void BuildCommitShaAliases_IncludesFullAndShortShaForms()
    {
        var aliases = ChangelogController.BuildCommitShaAliases(
            "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            "abcdeff");

        Assert.Contains("abcdef1234567890abcdef1234567890abcdef12", aliases);
        Assert.Contains("abcdef1", aliases);
        Assert.Contains("abcdeff", aliases);
    }

    [Fact]
    public void BuildRunExcludedDefectIds_ReturnsOnlyTerminalItems()
    {
        var run = new DefectAutomationRun
        {
            Items =
            [
                new DefectAutomationRunItem { DefectId = "fixed", Status = DefectAutomationRunItemStatus.Fixed },
                new DefectAutomationRunItem { DefectId = "failed", Status = DefectAutomationRunItemStatus.Failed },
                new DefectAutomationRunItem { DefectId = "commented", Status = DefectAutomationRunItemStatus.Commented },
                new DefectAutomationRunItem { DefectId = "commit", Status = DefectAutomationRunItemStatus.CommitWritten },
            ],
        };

        var excluded = DefectAgentController.BuildRunExcludedDefectIds(run);

        Assert.Contains("fixed", excluded);
        Assert.Contains("failed", excluded);
        Assert.DoesNotContain("commented", excluded);
        Assert.DoesNotContain("commit", excluded);
    }

    [Fact]
    public void BuildAutomationLightweightCriteria_ExposesIssueAutofixThresholds()
    {
        var criteria = DefectAgentController.BuildAutomationLightweightCriteria();

        Assert.Contains(criteria, x => x.Contains("200 行", StringComparison.Ordinal));
        Assert.Contains(criteria, x => x.Contains("10 分钟", StringComparison.Ordinal));
        Assert.Contains(criteria, x => x.Contains("数据库迁移", StringComparison.Ordinal));
        Assert.Contains(criteria, x => x.Contains("浏览器验收", StringComparison.Ordinal));
    }

    [Fact]
    public void BuildAutomationDailyPlanText_IncludesProbeBoundariesAndNoWorkRules()
    {
        var plan = DefectAgentController.BuildAutomationDailyPlanText(
            "https://map.ebcone.net/",
            "{K}",
            "project-1",
            "team-1",
            "submitted");

        Assert.Contains("domain: https://map.ebcone.net/", plan);
        Assert.Contains("K: {K}", plan);
        Assert.Contains("scope: defect-agent:use", plan);
        Assert.Contains("projectId: project-1", plan);
        Assert.Contains("teamId: team-1", plan);
        Assert.Contains("scripts/defect-automation-probe.mjs", plan);
        Assert.Contains("自检失败", plan);
        Assert.Contains("不要领取缺陷", plan);
        Assert.Contains("workflow.version 为 defect-agent-workflow.v1", plan);
        Assert.Contains("正式缺陷系统 domain 负责拉取真实缺陷", plan);
        Assert.Contains("测试或预览环境只负责修复验证与视觉验收", plan);
        Assert.Contains("不要从测试环境领取正式缺陷", plan);
        Assert.Contains("不要把 PR 已创建当成完成", plan);
        Assert.Contains("不要把正式发布前的缺陷通知给提交人", plan);
        Assert.Contains("start-next 返回 hasNext=false", plan);
        Assert.Contains("无正式发布后待验收通知项", plan);
        Assert.Contains("runId", plan);
        Assert.Contains("处理缺陷引用", plan);
        Assert.Contains("用户原始问题摘录", plan);
        Assert.Contains("修复 commit/PR 可点击证据", plan);
        Assert.Contains("验收事项清单", plan);
        Assert.Contains("验收报告链接", plan);
    }

    [Fact]
    public void CanReuseAutomationKey_RequiresActiveScopedAndUnexpiredKey()
    {
        var now = new DateTime(2026, 6, 18, 0, 0, 0, DateTimeKind.Utc);
        var reusable = new AgentApiKey
        {
            IsActive = true,
            Scopes = [DefectAgentController.AgentFixScope],
            ExpiresAt = now.AddDays(1),
        };
        var missingScope = new AgentApiKey { IsActive = true, Scopes = ["open-api:call"], ExpiresAt = now.AddDays(1) };
        var expired = new AgentApiKey { IsActive = true, Scopes = [DefectAgentController.AgentFixScope], ExpiresAt = now.AddSeconds(-1) };
        var revoked = new AgentApiKey { IsActive = true, Scopes = [DefectAgentController.AgentFixScope], RevokedAt = now };
        var neverExpires = new AgentApiKey { IsActive = true, Scopes = [DefectAgentController.AgentFixScope], ExpiresAt = null };

        Assert.True(DefectAgentController.CanReuseAutomationKey(reusable, now));
        Assert.True(DefectAgentController.CanReuseAutomationKey(neverExpires, now));
        Assert.False(DefectAgentController.CanReuseAutomationKey(missingScope, now));
        Assert.False(DefectAgentController.CanReuseAutomationKey(expired, now));
        Assert.False(DefectAgentController.CanReuseAutomationKey(revoked, now));
    }

    [Fact]
    public void CanAutomationAccessRun_AllowsOwnerManageOrAiAccessOnly()
    {
        var run = new DefectAutomationRun { CreatedBy = "owner" };

        Assert.True(DefectAgentController.CanAutomationAccessRun(run, "owner", false, false));
        Assert.True(DefectAgentController.CanAutomationAccessRun(run, "other", true, false));
        Assert.True(DefectAgentController.CanAutomationAccessRun(run, "other", false, true));
        Assert.False(DefectAgentController.CanAutomationAccessRun(run, "other", false, false));
        Assert.False(DefectAgentController.CanAutomationAccessRun(null, "owner", true, true));
    }

    [Fact]
    public void CanAutomationRunContinue_OnlyAllowsRunningRuns()
    {
        Assert.True(DefectAgentController.CanAutomationRunContinue(new DefectAutomationRun { Status = DefectAutomationRunStatus.Running }));
        Assert.False(DefectAgentController.CanAutomationRunContinue(new DefectAutomationRun { Status = DefectAutomationRunStatus.Failed }));
        Assert.False(DefectAgentController.CanAutomationRunContinue(new DefectAutomationRun { Status = DefectAutomationRunStatus.Completed }));
        Assert.False(DefectAgentController.CanAutomationRunContinue(null));
    }

    [Fact]
    public void IsAutomationRunClaimedDefect_RejectsUnclaimedAndTerminalItems()
    {
        var run = new DefectAutomationRun
        {
            Status = DefectAutomationRunStatus.Running,
            CurrentDefectId = "current",
            Items =
            [
                new DefectAutomationRunItem { DefectId = "fetched", Status = DefectAutomationRunItemStatus.Fetched },
                new DefectAutomationRunItem { DefectId = "commented", Status = DefectAutomationRunItemStatus.Commented },
                new DefectAutomationRunItem { DefectId = "commit", Status = DefectAutomationRunItemStatus.CommitWritten },
                new DefectAutomationRunItem { DefectId = "fixed", Status = DefectAutomationRunItemStatus.Fixed },
                new DefectAutomationRunItem { DefectId = "failed", Status = DefectAutomationRunItemStatus.Failed },
            ],
        };

        Assert.True(DefectAgentController.IsAutomationRunClaimedDefect(run, "current"));
        Assert.True(DefectAgentController.IsAutomationRunClaimedDefect(run, "fetched"));
        Assert.True(DefectAgentController.IsAutomationRunClaimedDefect(run, "commented"));
        Assert.True(DefectAgentController.IsAutomationRunClaimedDefect(run, "commit"));
        Assert.False(DefectAgentController.IsAutomationRunClaimedDefect(run, "fixed"));
        Assert.False(DefectAgentController.IsAutomationRunClaimedDefect(run, "failed"));
        Assert.False(DefectAgentController.IsAutomationRunClaimedDefect(run, "other"));
        Assert.False(DefectAgentController.IsAutomationRunClaimedDefect(new DefectAutomationRun { Status = DefectAutomationRunStatus.Failed, CurrentDefectId = "current" }, "current"));
    }

    [Fact]
    public void CanAutomationAccessDefect_LimitsScopedKeysToAssignedOrUnassignedDefects()
    {
        var assigned = new DefectReport { AssigneeId = "owner" };
        var unassigned = new DefectReport { AssigneeId = "" };
        var other = new DefectReport { AssigneeId = "other" };
        var deleted = new DefectReport { AssigneeId = "owner", IsDeleted = true };

        Assert.True(DefectAgentController.CanAutomationAccessDefect(assigned, "owner", false, false));
        Assert.True(DefectAgentController.CanAutomationAccessDefect(unassigned, "owner", false, false));
        Assert.True(DefectAgentController.CanAutomationAccessDefect(other, "owner", true, false));
        Assert.True(DefectAgentController.CanAutomationAccessDefect(other, "owner", false, true));
        Assert.False(DefectAgentController.CanAutomationAccessDefect(other, "owner", false, false));
        Assert.False(DefectAgentController.CanAutomationAccessDefect(deleted, "owner", true, true));
    }

    [Fact]
    public void CanAutomationAccessTrace_LimitsValidationReportToOwningKey()
    {
        var trace = new DefectResolutionTrace { AgentIdentifier = "key-1" };

        Assert.True(DefectAgentController.CanAutomationAccessTrace(trace, "key-1", false, false));
        Assert.True(DefectAgentController.CanAutomationAccessTrace(trace, "key-2", true, false));
        Assert.True(DefectAgentController.CanAutomationAccessTrace(trace, "key-2", false, true));
        Assert.False(DefectAgentController.CanAutomationAccessTrace(trace, "key-2", false, false));
        Assert.False(DefectAgentController.CanAutomationAccessTrace(null, "key-1", true, true));
    }

    [Fact]
    public void ResolveAutomationAgentIdentifier_PrefersAgentApiKeyId()
    {
        Assert.Equal("agent-key-1", DefectAgentController.ResolveAutomationAgentIdentifier(" agent-key-1 ", "app-1"));
        Assert.Equal("app-1", DefectAgentController.ResolveAutomationAgentIdentifier(null, " app-1 "));
        Assert.Null(DefectAgentController.ResolveAutomationAgentIdentifier("", " "));
    }

    [Fact]
    public void MergeAutomationCommitStructuredData_WritesCommitInfoKeys()
    {
        var structured = DefectAgentController.MergeAutomationCommitStructuredData(
            new Dictionary<string, string> { ["已有字段"] = "保留" },
            new SubmitAutomationCommitInfoRequest
            {
                CommitSha = "ABCDEF1234567890",
                CommitMessage = "fix(prd-admin): 修复缺陷",
                CommitUrl = "https://example.com/commit/abcdef1",
                Repository = "prd-agent",
                Branch = "codex/defect-automation",
                PullRequestNumber = 861,
                PullRequestUrl = "https://github.com/inernoro/prd_agent/pull/861",
                PreviewUrl = "https://preview.example.com/changelog",
                VisualReportUrl = "https://report.example.com",
            });

        Assert.Equal("保留", structured["已有字段"]);
        Assert.Equal("abcdef1234567890", structured["提交信息"]);
        Assert.Equal("abcdef1234567890", structured["修复提交"]);
        Assert.Equal("abcdef1", structured["修复提交短ID"]);
        Assert.Equal("fix(prd-admin): 修复缺陷", structured["修复提交说明"]);
        Assert.Equal("https://example.com/commit/abcdef1", structured["修复提交地址"]);
        Assert.Equal("prd-agent", structured["修复仓库"]);
        Assert.Equal("codex/defect-automation", structured["修复分支"]);
        Assert.Equal("861", structured["修复PR编号"]);
        Assert.Equal("https://github.com/inernoro/prd_agent/pull/861", structured["修复PR地址"]);
        Assert.Equal("https://preview.example.com/changelog", structured["预览地址"]);
        Assert.Equal("https://report.example.com", structured["视觉验收报告"]);
    }

    [Theory]
    [InlineData(null, "pass")]
    [InlineData("", "pass")]
    [InlineData("PASS", "pass")]
    [InlineData("conditional", "conditional")]
    [InlineData("fail", "fail")]
    [InlineData("invalid", "invalid")]
    [InlineData("unknown", "pass")]
    public void NormalizeValidationVerdict_DefaultsToPass(string? input, string expected)
    {
        Assert.Equal(expected, DefectAgentController.NormalizeValidationVerdict(input));
    }

    [Fact]
    public void BuildValidationNotificationMessage_UsesFailCopyForFailedAcceptance()
    {
        var defect = new DefectReport
        {
            Title = "发布中心缺陷关联混淆",
            DefectNo = "BUG-1",
        };

        Assert.Contains("需要继续改进", DefectAgentController.BuildValidationNotificationMessage(defect, "fail"));
        Assert.Contains("已修复并发布", DefectAgentController.BuildValidationNotificationMessage(defect, "pass"));
        Assert.Contains("陈述不成立", DefectAgentController.BuildValidationNotificationMessage(defect, "invalid"));
    }

    [Fact]
    public void BuildCompletionEvidenceComment_RequiresPrCommitAndValidationReport()
    {
        var request = new CompleteDefectAutomationWorkflowRequest
            {
                CommitSha = "abcdef1234567890",
                CommitMessage = "fix(prd-api): 修复缺陷自动化证据链",
                CommitUrl = "https://github.com/inernoro/prd_agent/commit/abcdef1",
                PullRequestNumber = 861,
                PullRequestUrl = "https://github.com/inernoro/prd_agent/pull/861",
                PreviewUrl = "https://preview.example.com/changelog",
            };
        var defect = new DefectReport
            {
                DefectNo = "DEF-2026-0188",
                Title = "更新中心关联缺陷不可见",
                RawContent = "用户在更新中心只能悬浮看到链接，列表中看不到缺陷内容和关联入口。",
                StructuredData = new Dictionary<string, string>
                {
                    ["影响位置"] = "更新中心 GitHub 待审核提交列表",
                    ["期望结果"] = "关联缺陷按钮可见，点击后展示缺陷详情、提交和验收报告。",
                },
            };
        var comment = DefectAgentController.BuildCompletionEvidenceComment(request, "abcdef1", defect);

        Assert.Contains("缺陷引用", comment);
        Assert.Contains("DEF-2026-0188 更新中心关联缺陷不可见", comment);
        Assert.Contains("用户原始问题：用户在更新中心只能悬浮看到链接", comment);
        Assert.Contains("修复目标：解决“更新中心关联缺陷不可见”描述的用户可见问题", comment);
        Assert.Contains("PR #861", comment);
        Assert.Contains("abcdef1 fix(prd-api): 修复缺陷自动化证据链", comment);
        Assert.Contains("正式环境发布后生成并回写", comment);
        Assert.Contains("需要真人审核发布", comment);
    }

    [Fact]
    public void BuildValidationEvidenceComment_CitesReportCommitAndPrForInvalidVerdict()
    {
        var comment = DefectAgentController.BuildValidationEvidenceComment(
            new DefectResolutionTrace
            {
                ShortSha = "abcdef1",
                CommitMessage = "fix(prd-api): 修复缺陷自动化证据链",
                CommitUrl = "https://github.com/inernoro/prd_agent/commit/abcdef1",
                PullRequestNumber = 861,
                PullRequestUrl = "https://github.com/inernoro/prd_agent/pull/861",
            },
            new SubmitPublishedValidationReportRequest
            {
                Message = "报告显示正式环境无法复现该问题。",
            },
            "缺陷修复验收报告",
            "https://map.ebcone.net/document-store/report",
            "https://map.ebcone.net/report/visual",
            "invalid");

        Assert.Contains("缺陷陈述不成立", comment);
        Assert.Contains("缺陷修复验收报告", comment);
        Assert.Contains("PR #861", comment);
        Assert.Contains("abcdef1 fix(prd-api): 修复缺陷自动化证据链", comment);
        Assert.Contains("报告显示正式环境无法复现该问题", comment);
    }
}
