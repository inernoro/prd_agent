using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public sealed class VersionRegistryCatalogTests
{
    [Fact]
    public void NormalizeName_忽略空白并统一大小写()
    {
        Assert.Equal("IMP助手", VersionRegistryCatalog.NormalizeName(" IMP 助手 "));
    }

    [Fact]
    public void CreateApplicationId_同名应用始终使用同一稳定标识()
    {
        var first = VersionRegistryCatalog.CreateApplicationId(VersionRegistryCatalog.NormalizeName("品牌商后台基础"));
        var second = VersionRegistryCatalog.CreateApplicationId(VersionRegistryCatalog.NormalizeName(" 品牌商后台基础 "));

        Assert.Equal(first, second);
    }

    [Fact]
    public void CreateSequenceId_同一类型在不同应用中独立()
    {
        var firstApplication = VersionRegistryCatalog.CreateApplicationId(VersionRegistryCatalog.NormalizeName("互动营销"));
        var secondApplication = VersionRegistryCatalog.CreateApplicationId(VersionRegistryCatalog.NormalizeName("会员小程序"));

        Assert.NotEqual(
            VersionRegistryCatalog.CreateSequenceId("T", firstApplication),
            VersionRegistryCatalog.CreateSequenceId("T", secondApplication));
        Assert.NotEqual(
            VersionRegistryCatalog.CreateSequenceId("T", firstApplication),
            VersionRegistryCatalog.CreateSequenceId("V", firstApplication));
    }

    [Fact]
    public void InitialSeeds_应用全局唯一并保留最新编号基线()
    {
        var applications = VersionRegistryCatalog.InitialSeeds;

        Assert.Equal(applications.Count, applications.Select(item => VersionRegistryCatalog.NormalizeName(item.ApplicationName)).Distinct().Count());
        var brandConsole = Assert.Single(applications, item => item.ApplicationName == "品牌商后台基础");
        Assert.Equal("大数据引擎系统", brandConsole.SystemName);
        Assert.Equal("T6.18.9", brandConsole.InternalBaselineCode);
        Assert.Equal("V4.26.1", brandConsole.FormalBaselineCode);
    }

    [Fact]
    public void InitialSystemNames_保留完整历史系统目录()
    {
        var systems = VersionRegistryCatalog.InitialSystemNames;

        Assert.Equal(5, systems.Count);
        Assert.Equal(systems.Count, systems.Select(VersionRegistryCatalog.NormalizeName).Distinct().Count());
        Assert.Contains("赋码采集关联系统", systems);
        Assert.All(VersionRegistryCatalog.InitialSeeds, seed => Assert.Contains(seed.SystemName, systems));
    }
}
