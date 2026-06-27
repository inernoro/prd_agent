using System.Collections.Generic;
using System.Linq;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 知识库模板校验单元测试（design.acceptance.kb.md §5.B）。
/// 纯函数校验，无需 DB —— 验证机器归档缺必填 metadata / 正文 section 被识别。
/// </summary>
public class AcceptanceTemplateRegistryTests
{
    private static KbTemplate Template
        => AcceptanceTemplateRegistry.FindByKey(AcceptanceTemplateRegistry.AcceptanceReportV2)!;

    [Fact]
    public void FindByKey_KnownKey_ReturnsTemplate()
    {
        Assert.NotNull(AcceptanceTemplateRegistry.FindByKey(AcceptanceTemplateRegistry.AcceptanceReportV2));
        Assert.Null(AcceptanceTemplateRegistry.FindByKey("nonexistent"));
        Assert.Null(AcceptanceTemplateRegistry.FindByKey(null));
    }

    [Fact]
    public void ValidateMetadata_AllPresent_NoProblems()
    {
        var meta = new Dictionary<string, string>
        {
            ["verdict"] = "pass",
            ["tier"] = "L1",
            ["target"] = "验收报告知识库",
        };
        var problems = AcceptanceTemplateRegistry.ValidateMetadata(Template, meta);
        Assert.Empty(problems);
    }

    [Fact]
    public void ValidateMetadata_MissingTarget_ReportsMissing()
    {
        var meta = new Dictionary<string, string>
        {
            ["verdict"] = "fail",
            ["tier"] = "L0",
        };
        var problems = AcceptanceTemplateRegistry.ValidateMetadata(Template, meta);
        Assert.Contains(problems, p => p.Contains("target"));
    }

    [Fact]
    public void ValidateMetadata_NullMetadata_ReportsAllRequired()
    {
        var problems = AcceptanceTemplateRegistry.ValidateMetadata(Template, null);
        Assert.Equal(Template.RequiredMetadataKeys.Length, problems.Count);
    }

    [Theory]
    [InlineData("PASS")]
    [InlineData("conditional")]
    [InlineData("Fail")]
    public void ValidateMetadata_VerdictCaseInsensitive_Accepted(string verdict)
    {
        var meta = new Dictionary<string, string>
        {
            ["verdict"] = verdict,
            ["tier"] = "L1",
            ["target"] = "某功能验收",
        };
        var problems = AcceptanceTemplateRegistry.ValidateMetadata(Template, meta);
        Assert.Empty(problems);
    }

    [Fact]
    public void ValidateMetadata_IllegalVerdict_Rejected()
    {
        var meta = new Dictionary<string, string>
        {
            ["verdict"] = "maybe",
            ["tier"] = "L1",
            ["target"] = "某功能验收",
        };
        var problems = AcceptanceTemplateRegistry.ValidateMetadata(Template, meta);
        Assert.Contains(problems, p => p.Contains("verdict"));
    }

    [Fact]
    public void ValidateContentSections_HasRequirementTable_Passes()
    {
        // 模拟标准 v2 报告：H1 标题 + 速览 + 「## 需求一一对应表」段
        var content = "# 项目 · 模块 · 验收报告\n\n> Verdict: 通过\n\n## 步骤 1 · 登录\n\n## 需求一一对应表\n\n| # | 诉求 | 状态 |\n";
        var problems = AcceptanceTemplateRegistry.ValidateContentSections(Template, content);
        Assert.Empty(problems);
    }

    [Fact]
    public void ValidateContentSections_MissingRequirementTable_Reported()
    {
        var content = "# 项目 · 验收报告\n\n## 步骤 1 · 登录\n\n## 步骤 2 · 操作\n";
        var problems = AcceptanceTemplateRegistry.ValidateContentSections(Template, content);
        Assert.Contains(problems, p => p.Contains("需求一一对应表"));
    }

    [Fact]
    public void ValidateContentSections_WhitespaceInHeading_StillMatches()
    {
        // H2 标题带额外空白也应匹配（归一化去空白）
        var content = "# T\n\n##   需求一一对应表  \n\n表格...\n";
        var problems = AcceptanceTemplateRegistry.ValidateContentSections(Template, content);
        Assert.Empty(problems);
    }
}
