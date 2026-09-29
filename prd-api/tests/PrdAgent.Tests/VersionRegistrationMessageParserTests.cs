using PrdAgent.Api.Services.ReviewAgent;
using Xunit;

namespace PrdAgent.Tests;

public sealed class VersionRegistrationMessageParserTests
{
    [Fact]
    public void Parse_内部版本企微格式_只回填已出现的立项字段()
    {
        const string message = """
            【版本立项】
            项目类别：非定制
            版本类别：小版本
            是否需要UI设计：否
            是否属于AI POC项目：是
            需求来源：登康
            产品立项方案名称：互动营销（渠道返利按渠道关系返利门店扫动销码领奖支持开启业务员返利）
            计划立项时间：2026.09.30
            """;

        var result = VersionRegistrationMessageParser.Parse(message, "internal");

        Assert.Equal("standard", result.ProjectType);
        Assert.Equal("minor", result.VersionType);
        Assert.False(result.NeedUiDesign ?? true);
        Assert.True(result.IsAiPoc ?? false);
        Assert.Equal("登康", result.DemandSource);
        Assert.Equal("互动营销（渠道返利按渠道关系返利门店扫动销码领奖支持开启业务员返利）", result.PlanName);
        Assert.Equal(new DateTime(2026, 9, 30), result.PlannedProjectAt!.Value);
        Assert.Null(result.PlanUrl);
        Assert.Null(result.PlannedReleaseAt);
    }

    [Fact]
    public void Parse_正式版本企微格式_识别上线字段与成员()
    {
        const string message = """
            【版本上线】
            项目类别：定制
            版本类别：小版本
            是否全域开放：是
            需求来源：拜耳
            产品方案名称：NO.81品牌商后台基础T6.18.6（验真匹配新增支持高德数据接口）AI文档
            方案地址：https://miduo1031.yuque.com/rsaesz/oqbs8t/cozs3e0fueazdweh#gtBBz
            项目组成员：宇凡、火巍、启芬、泽腾
            计划上线时间：2026.9.21
            """;

        var result = VersionRegistrationMessageParser.Parse(message, "formal");

        Assert.Equal("custom", result.ProjectType);
        Assert.Equal("minor", result.VersionType);
        Assert.True(result.IsGlobalOpen ?? false);
        Assert.Equal("拜耳", result.DemandSource);
        Assert.Equal("NO.81品牌商后台基础T6.18.6（验真匹配新增支持高德数据接口）AI文档", result.PlanName);
        Assert.Equal("https://miduo1031.yuque.com/rsaesz/oqbs8t/cozs3e0fueazdweh#gtBBz", result.PlanUrl);
        Assert.Equal(new[] { "宇凡", "火巍", "启芬", "泽腾" }, result.ProjectMemberNames);
        Assert.Equal(new DateTime(2026, 9, 21), result.PlannedReleaseAt!.Value);
        Assert.Equal("T6.18.6", result.TCode);
    }

    [Fact]
    public void Parse_未知字段不补造内容()
    {
        var result = VersionRegistrationMessageParser.Parse("【版本上线】\n需求描述：请尽快处理", "formal");

        Assert.Empty(result.MatchedFields);
        Assert.Null(result.DemandSource);
        Assert.Null(result.PlanName);
        Assert.Null(result.PlannedReleaseAt);
        Assert.Empty(result.ProjectMemberNames);
    }
}
