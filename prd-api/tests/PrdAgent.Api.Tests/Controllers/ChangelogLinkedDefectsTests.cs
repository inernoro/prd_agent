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
