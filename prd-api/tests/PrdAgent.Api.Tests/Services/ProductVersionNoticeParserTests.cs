using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionNoticeParserTests
{
    [Theory]
    [InlineData("internal")]
    [InlineData("formal")]
    public void RecognizesCanonicalMultilineAndBoldPlanFieldsWithoutChangingOtherFields(string kind)
    {
        const string url = "https://example.test/plan?revision=2&view=full";
        foreach (var text in new[] {
            $"产品方案名称：演示方案\n方案地址：{url}\n需求来源：内部",
            $"产品方案名称：\n演示方案\n方案地址：\n{url}\n需求来源：内部",
            $"**产品方案名称**：**演示方案**\n**方案地址：** <{url}>\n需求来源：内部",
            $"**产品方案名称：演示方案**\n方案链接：[{nameof(url)}]({url})\n需求来源：内部",
        })
        {
            var parsed = ProductVersionNoticeParser.Parse(text, kind);
            Assert.Equal("演示方案", parsed.PlanName);
            Assert.Equal(url, parsed.PlanUrl);
            Assert.Equal("内部", parsed.DemandSource);
            Assert.Contains("planName", parsed.MatchedFields);
            Assert.Contains("planUrl", parsed.MatchedFields);
        }
    }

    [Theory]
    [InlineData("internal")]
    [InlineData("formal")]
    public void ReadsLinkAttachedToPlanTitleAndPrefersExplicitPlanAddress(string kind)
    {
        const string title = "产品立项方案名称：\n[演示方案](https://example.test/title)";
        var parsed = ProductVersionNoticeParser.Parse(title, kind);
        Assert.Equal("演示方案", parsed.PlanName);
        Assert.Equal("https://example.test/title", parsed.PlanUrl);
        parsed = ProductVersionNoticeParser.Parse(title + "\n方案地址：https://example.test/explicit", kind);
        Assert.Equal("https://example.test/explicit", parsed.PlanUrl);
    }

    [Fact]
    public void MissingFieldsDoNotConsumeAnotherFieldOrUnrelatedReference()
    {
        var parsed = ProductVersionNoticeParser.Parse("产品立项方案名称：\n需求来源：内部\n方案地址：\n计划上线时间：2026.11.23\n参考：https://example.test/other", "formal");
        Assert.Null(parsed.PlanName);
        Assert.Null(parsed.PlanUrl);
        Assert.Equal("内部", parsed.DemandSource);
        Assert.Equal(new DateTime(2026, 11, 23), parsed.PlannedReleaseAt);
        Assert.Null(ProductVersionNoticeParser.Parse("产品方案名称：\nT1.2.3", "formal").PlanName);
        Assert.Null(ProductVersionNoticeParser.Parse("方案地址：javascript:alert(1)", "formal").PlanUrl);
    }

    [Fact]
    public void ExistingTAndVNotificationFieldOrderAndStructureStayUnchanged()
    {
        var t = ProductVersionCopyTemplate.Build(new ProductInitiation {
            TCode = "T1.2.3", PlanName = "原方案", PlanUrl = "https://example.test/t", OwnerName = "负责人",
        });
        Assert.Equal(new[] { "【版本立项】", "项目类别", "版本类别", "是否需要UI设计", "是否属于AI POC项目",
            "需求来源", "产品立项方案名称", "计划立项时间", "产品负责人", "T1.2.3" },
            t.Split('\n').Select(line => line.Split('：')[0]));
        var v = ProductVersionCopyTemplate.Build(new ProductRelease {
            VCode = "V1.2.3", PlanName = "原方案", PlanUrl = "https://example.test/v",
            ProjectType = "standard", IsGlobalOpen = true, OwnerName = "负责人",
        });
        Assert.Equal(new[] { "【版本上线】", "项目类别", "版本类别", "是否全域开放", "需求来源", "产品方案名称",
            "方案地址", "项目组成员", "计划上线时间", "预计培训时长", "产品负责人", "V1.2.3" },
            v.Split('\n').Select(line => line.Split('：')[0]));
    }
}
