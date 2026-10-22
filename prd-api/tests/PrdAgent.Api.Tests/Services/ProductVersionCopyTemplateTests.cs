using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionCopyTemplateTests
{
    [Theory]
    [InlineData("品牌商后台基础（卡券功能优化）AI文档", "品牌商后台基础T6.18.15（卡券功能优化）AI文档")]
    [InlineData("品牌商后台基础(卡券功能优化)AI文档", "品牌商后台基础T6.18.15(卡券功能优化)AI文档")]
    [InlineData("品牌商后台基础T6.18.15（卡券功能优化）AI文档", "品牌商后台基础T6.18.15（卡券功能优化）AI文档")]
    [InlineData("品牌商后台基础T6.18.9（兼容T6.18.8）AI文档", "品牌商后台基础T6.18.15（兼容T6.18.8）AI文档")]
    [InlineData("手工方案名称", "手工方案名称T6.18.15")]
    [InlineData("", "")]
    public void 完整通知仅在名称前缀插入当前T号且不改已保存名称(string name, string expected)
    {
        var item = new ProductInitiation { PlanName = name, TCode = "T6.18.15", OwnerName = "杨锐聪" };
        var message = ProductVersionCopyTemplate.Build(item);
        message.ShouldContain($"产品立项方案名称：{expected}\n");
        message.ShouldEndWith("产品负责人：杨锐聪\nT6.18.15");
        item.PlanName.ShouldBe(name);
    }

    [Fact]
    public void 未发T号不伪造版本且旧登记模板仍保持原名称()
    {
        const string name = "应用（优化）AI文档";
        ProductVersionCopyTemplate.Build(new ProductInitiation { PlanName = name }).ShouldContain($"产品立项方案名称：{name}\n");
        VersionRegistrationCopyTemplate.Build(new VersionRegistration { Kind = VersionRegistrationKind.Internal, PlanName = name, Code = "T1.2.3" }).ShouldContain($"产品立项方案名称：{name}\n");
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
        message.ShouldContain("产品方案名称：正式上线方案\n");
        message.ShouldEndWith("V4.26.1");
    }
}
