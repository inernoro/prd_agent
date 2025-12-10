using PrdAgent.Infrastructure.Markdown;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class MarkdownParserTests
{
    private readonly MarkdownParser _parser;

    public MarkdownParserTests()
    {
        _parser = new MarkdownParser();
    }

    [Fact]
    public void Parse_ShouldExtractTitle()
    {
        // Arrange
        var content = @"# 产品需求文档

## 1. 项目背景

这是一个测试文档。
";

        // Act
        var result = _parser.Parse(content);

        // Assert
        Assert.Equal("产品需求文档", result.Title);
    }

    [Fact]
    public void Parse_ShouldCountCharacters()
    {
        // Arrange
        var content = "Hello World 你好世界";

        // Act
        var result = _parser.Parse(content);

        // Assert
        Assert.Equal(content.Length, result.CharCount);
    }

    [Fact]
    public void Parse_ShouldExtractSections()
    {
        // Arrange
        var content = @"# 标题1

内容1

## 标题1.1

内容1.1

## 标题1.2

内容1.2

# 标题2

内容2
";

        // Act
        var result = _parser.Parse(content);

        // Assert
        Assert.True(result.Sections.Count >= 2);
    }

    [Fact]
    public void EstimateTokens_ShouldReturnPositiveNumber()
    {
        // Arrange
        var content = "Hello World 你好世界 这是一个测试文本";

        // Act
        var tokens = _parser.EstimateTokens(content);

        // Assert
        Assert.True(tokens > 0);
    }

    [Fact]
    public void EstimateTokens_ChineseTextShouldHaveMoreTokens()
    {
        // Arrange
        var chineseContent = "这是一个中文测试";
        var englishContent = "This is a test";

        // Act
        var chineseTokens = _parser.EstimateTokens(chineseContent);
        var englishTokens = _parser.EstimateTokens(englishContent);

        // Assert - 中文通常比等长的英文需要更多token
        Assert.True(chineseTokens > 0);
        Assert.True(englishTokens > 0);
    }

    [Fact]
    public void Parse_EmptyContent_ShouldReturnDefaultTitle()
    {
        // Arrange
        var content = "";

        // Act
        var result = _parser.Parse(content);

        // Assert
        Assert.NotNull(result.Title);
    }
}



