using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class TapdBugAgentServiceTests
{
    [Fact]
    public void NormalizeDraft_ShouldMapChineseEnumsAndDefaultFields()
    {
        var draft = TapdBugAgentService.NormalizeDraft(new TapdBugDraft
        {
            Title = "产品库实物附近门店H5，地区筛选选择后无过滤效果",
            Severity = "主要",
            Priority = "高",
            Preconditions = new List<string> { "品牌已开通防窜物流" },
            Steps = new List<string> { "1. 进入附近门店页面" },
            ActualResult = new List<string> { "仍展示全国门店" },
            ExpectedResult = new List<string> { "仅展示所选地区门店" },
        }, null);

        Assert.Equal("serious", draft.Severity);
        Assert.Equal("high", draft.Priority);
        Assert.Equal("附近门店组件精准筛选", draft.Module);
        Assert.Equal("黄卫杰;", draft.CurrentOwner);
        Assert.Empty(draft.MissingFields);
        Assert.Equal("进入附近门店页面", draft.Steps[0]);
    }

    [Fact]
    public void NormalizeDraft_ShouldReportMissingRequiredFields()
    {
        var draft = TapdBugAgentService.NormalizeDraft(new TapdBugDraft
        {
            Title = "地区筛选无效",
            ActualResult = new List<string> { "列表无变化" },
        }, null);

        Assert.Contains("前置条件", draft.MissingFields);
        Assert.Contains("复现步骤", draft.MissingFields);
        Assert.Contains("预期结果", draft.MissingFields);
        Assert.DoesNotContain("实际结果", draft.MissingFields);
    }

    [Fact]
    public void BuildDescriptionHtml_ShouldEscapeUserInput()
    {
        var html = TapdBugAgentService.BuildDescriptionHtml(
            new List<string> { "<script>alert(1)</script>" },
            new List<string> { "点击筛选" },
            new List<string> { "列表无变化" },
            new List<string> { "只展示所选地区" });

        Assert.Contains("&lt;script&gt;alert(1)&lt;/script&gt;", html);
        Assert.DoesNotContain("<script>alert(1)</script>", html);
        Assert.Contains("<h3>复现步骤</h3>", html);
    }

    [Fact]
    public void ParseDraftFromLlm_ShouldReadStrictJson()
    {
        var draft = TapdBugAgentService.ParseDraftFromLlm("""
        ```json
        {
          "title": "地区筛选无效",
          "severity": "normal",
          "priority": "medium",
          "bugType": "逻辑错误",
          "preconditions": ["已登录"],
          "steps": ["进入页面"],
          "actualResult": ["无过滤"],
          "expectedResult": ["按地区过滤"]
        }
        ```
        """);

        Assert.Equal("地区筛选无效", draft.Title);
        Assert.Equal("normal", draft.Severity);
        Assert.Equal("medium", draft.Priority);
        Assert.Single(draft.Steps);
    }
}
