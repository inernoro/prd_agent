using PrdAgent.Infrastructure.Services.ProjectRouteAgent;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// MarkdownSectionExtractor 「文档头模式」回归测试。
///
/// 场景背景：项目路由智能体让用户上传方案 .md，AI 需要从中提取 apps / modules。
/// 用户实际方案文档不是 `## 应用` 这种独立小节，而是这种「文档头」聚合节点：
///
///   # 一、文档头
///   - 文档名称：智能营销T3.1.11
///   - 应用/业务模块：智能营销/营销后台
///   - 版本：T3.11.1
///
/// 这种格式之前会被忽略导致兜底走 LLM。文档头模式直接按规则读出来。
/// </summary>
public class MarkdownSectionExtractorTests
{
    [Fact]
    public void DocHeader_MergedLabel_SplitsAppsAndModules()
    {
        // 用户截图里的真实场景
        var md = @"# 一、文档头

- 文档名称：智能营销T3.1.11（自动领奖与出货单同步截止管理优化）
- 应用/业务模块：智能营销/营销后台
- 版本：T3.11.1
- 迭代类型：优化
- 作者（PM）：陈凯婷
- 审批人（Owner）：潘洪玉、王忠
";
        var (apps, modules) = MarkdownSectionExtractor.Extract(md);
        Assert.Single(apps);
        Assert.Equal("智能营销", apps[0]);
        Assert.Single(modules);
        Assert.Equal("营销后台", modules[0]);
    }

    [Fact]
    public void DocHeader_SeparateLines_AppsAndModulesIndependent()
    {
        var md = @"## 文档信息

- 应用：智能营销
- 业务模块：营销后台
- 版本：T3.11.1
";
        var (apps, modules) = MarkdownSectionExtractor.Extract(md);
        Assert.Single(apps);
        Assert.Equal("智能营销", apps[0]);
        Assert.Single(modules);
        Assert.Equal("营销后台", modules[0]);
    }

    [Fact]
    public void DocHeader_BoldKeyAndFullWidthSlash_StillExtracts()
    {
        // 加粗 + 全角斜杠 + 全角冒号
        var md = @"# 文档头
- **应用／业务模块**：智能营销／营销后台
- 版本：T3.11.1
";
        var (apps, modules) = MarkdownSectionExtractor.Extract(md);
        Assert.Equal("智能营销", apps[0]);
        Assert.Equal("营销后台", modules[0]);
    }

    [Fact]
    public void DocHeader_ValueWithChinaCommaInsteadOfSlash_FallsBackToCommaSplit()
    {
        // value 没用 `/` 而用 `、` 分隔，仍要能拆
        var md = @"# 文档头
- 应用/业务模块：智能营销、营销后台
- 版本：T3.11.1
";
        var (apps, modules) = MarkdownSectionExtractor.Extract(md);
        Assert.Single(apps);
        Assert.Equal("智能营销", apps[0]);
        Assert.Single(modules);
        Assert.Equal("营销后台", modules[0]);
    }

    [Fact]
    public void DocHeader_MultipleAppsAndModules_OnSeparateLines()
    {
        var md = @"# 基本信息
- 应用：智能营销、智能仓储
- 业务模块：营销后台、库存中心、分销前台
";
        var (apps, modules) = MarkdownSectionExtractor.Extract(md);
        Assert.Equal(2, apps.Count);
        Assert.Contains("智能营销", apps);
        Assert.Contains("智能仓储", apps);
        Assert.Equal(3, modules.Count);
        Assert.Contains("营销后台", modules);
        Assert.Contains("库存中心", modules);
        Assert.Contains("分销前台", modules);
    }

    [Fact]
    public void StandaloneSections_StillWorkAsFallback()
    {
        // 没有「文档头」节点，回退到独立章节模式
        var md = @"## 应用
- 智能营销

## 业务模块
- 营销后台
";
        var (apps, modules) = MarkdownSectionExtractor.Extract(md);
        Assert.Single(apps);
        Assert.Equal("智能营销", apps[0]);
        Assert.Single(modules);
        Assert.Equal("营销后台", modules[0]);
    }

    [Fact]
    public void EmptyOrNoMatch_ReturnsEmpty()
    {
        var md = @"# 引言
随便写点啥，没有文档头也没有应用业务模块小节。
";
        var (apps, modules) = MarkdownSectionExtractor.Extract(md);
        Assert.Empty(apps);
        Assert.Empty(modules);
    }
}
