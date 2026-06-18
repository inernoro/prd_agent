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

        Assert.True(DefectAgentController.CanReuseAutomationKey(reusable, now));
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
        Assert.Equal("https://preview.example.com/changelog", structured["预览地址"]);
        Assert.Equal("https://report.example.com", structured["视觉验收报告"]);
    }

    [Theory]
    [InlineData(null, "pass")]
    [InlineData("", "pass")]
    [InlineData("PASS", "pass")]
    [InlineData("conditional", "conditional")]
    [InlineData("fail", "fail")]
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
    }
}
