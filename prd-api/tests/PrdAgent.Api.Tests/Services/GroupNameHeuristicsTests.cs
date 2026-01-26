using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class GroupNameHeuristicsTests
{
    [Theory]
    [InlineData("3.prd.md", "产品名称：PRD Agent（PRD智能解析助手）\n\n## 1. 产品概述", "PRD Agent")]
    [InlineData("支付系统PRD.md", "# 支付系统 产品需求文档\n\n### 背景", "支付系统")]
    [InlineData("2025-12-29_增长-实验_v1.2.md", "## 增长实验 需求文档\n\n- 目标：提升转化", "增长实验")]
    public void Suggest_ShouldPickReasonableName(string fileName, string snippet, string expected)
    {
        var actual = GroupNameHeuristics.Suggest(fileName, snippet, maxLen: 20);
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void Suggest_WhenOnlyNumberFileName_ShouldFallbackToDefault()
    {
        var actual = GroupNameHeuristics.Suggest("3.md", "   ", maxLen: 20);
        Assert.Equal("未命名群组", actual);
    }
}


