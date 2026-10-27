using PrdAgent.Core.Helpers;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionPlanNameTests
{
    [Theory]
    [InlineData("米多星球T3.14.1(IMP配套方案)AI文档1-3稿", "米多总平台T3.14.2（IMP配套方案）")]
    [InlineData("米多总平台 T待定（礼品中心化方案）AI 文档.md", "米多总平台T3.14.2（礼品中心化方案）")]
    [InlineData("米多总平台 任意旧内容（保留T1.2.3含义）第三稿", "米多总平台T3.14.2（保留T1.2.3含义）")]
    [InlineData("米多总平台T3.14.2（配置（高级）优化）", "米多总平台T3.14.2（配置（高级）优化）")]
    [InlineData("手动填写的新方案", "米多总平台T3.14.2（手动填写的新方案）")]
    public void 用实际应用和发放编号生成标准名称(string title, string expected)
        => ProductVersionPlanName.Format("米多总平台", "T3.14.2", title).ShouldBe(expected);
}
