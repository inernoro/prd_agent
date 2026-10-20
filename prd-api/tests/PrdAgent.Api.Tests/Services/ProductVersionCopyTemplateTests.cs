using PrdAgent.Api.Services.ReviewAgent;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionCopyTemplateTests
{
    [Fact]
    public void 内部立项复用企微模板并保留已填写信息()
    {
        var item = new ProductInitiation
        {
            TCode = "T6.18.9", ProjectType = "standard", VersionType = "minor",
            NeedUiDesign = false, IsAiPoc = true, DemandSource = "内部",
            PlanName = "版本立项方案", PlannedProjectAt = new DateTime(2026, 9, 29),
        };

        var message = ProductVersionCopyTemplate.Build(item);
        message.ShouldContain("【版本立项】");
        message.ShouldContain("是否需要UI设计：否");
        message.ShouldContain("是否属于AI POC项目：是");
        message.ShouldContain("需求来源：内部");
        message.ShouldEndWith("T6.18.9");
    }

    [Fact]
    public void 正式上线模板包含分钟培训时长和项目成员()
    {
        var item = new ProductRelease
        {
            VCode = "V4.26.1", ProjectType = "custom", VersionType = "minor",
            IsGlobalOpen = true, DemandSource = "拜耳", PlanName = "正式上线方案",
            PlanUrl = "https://example.test/plan",
            ProjectMemberNames = new() { "宇凡", "火巍" },
            PlannedReleaseAt = new DateTime(2026, 9, 21),
            PlannedTrainingMinutes = 30,
        };

        var message = ProductVersionCopyTemplate.Build(item);
        message.ShouldContain("【版本上线】");
        message.ShouldContain("项目组成员：宇凡、火巍");
        message.ShouldContain("预计培训时长：30 分钟");
        message.ShouldEndWith("V4.26.1");
    }
}
