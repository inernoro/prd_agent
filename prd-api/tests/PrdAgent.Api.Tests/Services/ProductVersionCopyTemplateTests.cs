using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionCopyTemplateTests
{
    [Theory]
    [InlineData("品牌商后台基础 T待定（礼品中心化方案）AI 文档", "品牌商后台基础T6.18.16（礼品中心化方案）AI 文档")]
    [InlineData("品牌商后台基础T6.18.9（兼容T6.18.8）AI文档", "品牌商后台基础T6.18.16（兼容T6.18.8）AI文档")]
    [InlineData("品牌商后台基础 任意旧内容 T待定(礼品中心化方案)AI 文档", "品牌商后台基础T6.18.16(礼品中心化方案)AI 文档")]
    [InlineData("品牌商后台基础T6.18.16（礼品中心化方案）AI文档", "品牌商后台基础T6.18.16（礼品中心化方案）AI文档")]
    [InlineData("手动填写无括号方案", "手动填写无括号方案")]
    public void 新申领通知按已选应用和实际T号重建括号前内容(string name, string expected)
    {
        var item = new ProductInitiation
        {
            AppName = "品牌商后台基础", PlanName = name, TCode = "T6.18.16", OwnerName = "周泽腾",
        };
        var message = ProductVersionCopyTemplate.Build(item);
        message.ShouldContain($"产品立项方案名称：{expected}\n");
        message.ShouldEndWith("产品负责人：周泽腾\nT6.18.16");
        item.PlanName.ShouldBe(name);
        item.AppName.ShouldBe("品牌商后台基础");
        item.TCode.ShouldBe("T6.18.16");
    }

    [Theory]
    [InlineData(null, "T6.18.16")]
    [InlineData("品牌商后台基础", null)]
    public void 缺少结构化应用或实际版本不猜测或改写标题(string? appName, string? code)
    {
        const string name = "品牌商后台基础 T待定（礼品中心化方案）AI 文档";
        ProductVersionCopyTemplate.Build(new ProductInitiation { AppName = appName, TCode = code, PlanName = name })
            .ShouldContain($"产品立项方案名称：{name}\n");
    }

    [Fact]
    public void 内部立项复用企微模板并保留已填写信息()
    {
        var item = new ProductInitiation
        {
            TCode = "T6.18.9", ProjectType = "standard", VersionType = "minor",
            NeedUiDesign = false, IsAiPoc = true, DemandSource = "内部",
            PlanName = "版本立项方案", PlannedProjectAt = new DateTime(2026, 9, 29), OwnerName = "代申请负责人",
        };

        var message = ProductVersionCopyTemplate.Build(item);
        message.ShouldContain("【版本立项】");
        message.ShouldContain("是否需要UI设计：否");
        message.ShouldContain("是否属于AI POC项目：是");
        message.ShouldContain("需求来源：内部");
        message.ShouldContain("产品负责人：代申请负责人");
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
            PlannedTrainingMinutes = 30, OwnerName = "正式负责人",
        };

        var message = ProductVersionCopyTemplate.Build(item);
        message.ShouldContain("【版本上线】");
        message.ShouldContain("项目组成员：宇凡、火巍");
        message.ShouldContain("预计培训时长：30 分钟");
        message.ShouldContain("产品负责人：正式负责人");
        message.ShouldEndWith("V4.26.1");
    }
}
