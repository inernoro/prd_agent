using PrdAgent.Api.Services.ReviewAgent;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class VersionRegistrationCopyTemplateTests
{
    [Fact]
    public void 内部版本号_生成历史版本立项模板()
    {
        var record = new VersionRegistration
        {
            Kind = VersionRegistrationKind.Internal,
            Code = "T6.18.9",
            ProjectType = "standard",
            VersionType = "minor",
            NeedUiDesign = false,
            IsAiPoc = true,
            DemandSource = "内部",
            PlanName = "品牌商后台基础（品牌红包新增接入商家转账）",
            PlannedProjectAt = new DateTime(2026, 9, 29),
        };

        VersionRegistrationCopyTemplate.Build(record).ShouldBe("""
            【版本立项】
            项目类别：非定制
            版本类别：小版本
            是否需要UI设计：否
            是否属于AI POC项目：是
            需求来源：内部
            产品立项方案名称：品牌商后台基础（品牌红包新增接入商家转账）
            计划立项时间：2026.9.29
            T6.18.9
            """);
    }

    [Fact]
    public void 正式版本号_生成历史版本上线模板并保留空字段()
    {
        var record = new VersionRegistration
        {
            Kind = VersionRegistrationKind.Formal,
            Code = "V4.26.1",
            ProjectType = "custom",
            VersionType = "minor",
            IsGlobalOpen = true,
            DemandSource = "拜耳",
            PlanName = "品牌商后台基础T6.18.6（验真匹配新增支持高德数据接口）AI文档",
            PlanUrl = "https://example.test/plan",
            ProjectMemberNames = new List<string> { "宇凡", "火巍", "启芬", "泽腾" },
            PlannedReleaseAt = new DateTime(2026, 9, 21),
            PlannedTrainingMinutes = 30,
        };

        VersionRegistrationCopyTemplate.Build(record).ShouldBe("""
            【版本上线】
            项目类别：定制
            版本类别：小版本
            是否全域开放：是
            需求来源：拜耳
            产品方案名称：品牌商后台基础T6.18.6（验真匹配新增支持高德数据接口）AI文档
            方案地址：https://example.test/plan
            项目组成员：宇凡、火巍、启芬、泽腾
            计划上线时间：2026.9.21
            预计培训时长：30 分钟
            V4.26.1
            """);

        record.PlanUrl = null;
        VersionRegistrationCopyTemplate.Build(record).ShouldContain("方案地址：\n");

        record.PlannedTrainingMinutes = null;
        VersionRegistrationCopyTemplate.Build(record).ShouldContain("预计培训时长：\n");
    }

    [Fact]
    public void 北京时间零点提交的计划日期_复制时不应显示为前一天()
    {
        var record = new VersionRegistration
        {
            Kind = VersionRegistrationKind.Internal,
            Code = "T1.2.3",
            PlannedProjectAt = new DateTime(2026, 10, 18, 16, 0, 0, DateTimeKind.Utc),
        };

        VersionRegistrationCopyTemplate.Build(record).ShouldContain("计划立项时间：2026.10.19");
    }
}
