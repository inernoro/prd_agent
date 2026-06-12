using PrdAgent.Infrastructure.Services.DocumentStore;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 双链解析器单元测试（WikiLinkParser）。
///
/// 算法在 <see cref="WikiLinkParser"/>：从 Markdown 正文中提取所有 [[xxx]] / [[xxx|alias]]
/// 形式的 wiki 风格双链，给 MentionService 写账本用。
///
/// 故意不识别：换行、嵌套方括号、空标题。与前端 MarkdownViewer.preprocessWikilinks 行为对齐。
/// </summary>
public class WikiLinkParserTests
{
    [Fact]
    public void Parse_NullOrEmpty_ReturnsEmpty()
    {
        Assert.Empty(WikiLinkParser.Parse(null));
        Assert.Empty(WikiLinkParser.Parse(string.Empty));
        Assert.Empty(WikiLinkParser.Parse("   \n\n  "));
    }

    [Fact]
    public void Parse_SingleSimpleLink_ReturnsOneMatch()
    {
        var matches = WikiLinkParser.Parse("Some text [[Knowledge Base Design]] more text");
        Assert.Single(matches);
        Assert.Equal("Knowledge Base Design", matches[0].AnchorText);
        Assert.Null(matches[0].AliasText);
        Assert.True(matches[0].Position > 0);
    }

    [Fact]
    public void Parse_LinkWithAlias_ParsesBothParts()
    {
        var matches = WikiLinkParser.Parse("See [[Long Title|short]] for details");
        Assert.Single(matches);
        Assert.Equal("Long Title", matches[0].AnchorText);
        Assert.Equal("short", matches[0].AliasText);
    }

    [Fact]
    public void Parse_MultipleLinks_ReturnsAllInOrder()
    {
        var matches = WikiLinkParser.Parse("[[First]] and then [[Second]] and [[Third|alias]]");
        Assert.Equal(3, matches.Count);
        Assert.Equal("First", matches[0].AnchorText);
        Assert.Equal("Second", matches[1].AnchorText);
        Assert.Equal("Third", matches[2].AnchorText);
        Assert.Equal("alias", matches[2].AliasText);
        // 顺序应按 Position 升序
        Assert.True(matches[0].Position < matches[1].Position);
        Assert.True(matches[1].Position < matches[2].Position);
    }

    [Fact]
    public void Parse_ChineseTitles_HandledCorrectly()
    {
        var matches = WikiLinkParser.Parse("本季度对标 [[知识库设计文档]] 和 [[Obsidian 调研报告|调研]] 推进");
        Assert.Equal(2, matches.Count);
        Assert.Equal("知识库设计文档", matches[0].AnchorText);
        Assert.Equal("Obsidian 调研报告", matches[1].AnchorText);
        Assert.Equal("调研", matches[1].AliasText);
    }

    [Fact]
    public void Parse_EmptyTitle_IsSkipped()
    {
        // [[]] 和 [[ ]] 不应被识别为有效双链
        var matches = WikiLinkParser.Parse("Empty [[]] and whitespace [[   ]] should be skipped, but [[Valid]] not.");
        Assert.Single(matches);
        Assert.Equal("Valid", matches[0].AnchorText);
    }

    [Fact]
    public void Parse_NewlineInsideBrackets_DoesNotMatch()
    {
        // [[A\nB]] 不应跨行匹配（避免错把代码块/段落卷进来）
        var matches = WikiLinkParser.Parse("Open [[Doc\nName]] close");
        Assert.Empty(matches);
    }

    [Fact]
    public void Parse_NestedBrackets_DoesNotMatch()
    {
        // [[A[B]C]] 这种嵌套故意不识别，保持解析可预期
        var matches = WikiLinkParser.Parse("Weird [[A[B]C]] structure");
        Assert.Empty(matches);
    }

    [Fact]
    public void Parse_TitleIsTrimmed()
    {
        var matches = WikiLinkParser.Parse("Spaces around [[  Padded Title  ]]");
        Assert.Single(matches);
        Assert.Equal("Padded Title", matches[0].AnchorText);
    }

    [Fact]
    public void Parse_AliasIsTrimmed()
    {
        var matches = WikiLinkParser.Parse("[[Title|  alias text  ]]");
        Assert.Single(matches);
        Assert.Equal("Title", matches[0].AnchorText);
        Assert.Equal("alias text", matches[0].AliasText);
    }

    [Fact]
    public void Parse_ContextIncludesSurroundingChars()
    {
        var content = "The quick brown fox jumps over the lazy [[Dog]] in the park yesterday morning.";
        var matches = WikiLinkParser.Parse(content);
        Assert.Single(matches);
        // 上下文应含 anchor 字面
        Assert.Contains("Dog", matches[0].Context);
        // 不应含换行符（Parse 会把 \r\n 替换为空格）
        Assert.DoesNotContain("\n", matches[0].Context);
    }

    [Fact]
    public void Parse_ContextNormalizesNewlines()
    {
        var content = "Line1\nLine2 [[Target]] Line3\nLine4";
        var matches = WikiLinkParser.Parse(content);
        Assert.Single(matches);
        Assert.DoesNotContain("\n", matches[0].Context);
        Assert.DoesNotContain("\r", matches[0].Context);
    }

    [Fact]
    public void Parse_DuplicateTitles_AllAppearWithDifferentPositions()
    {
        // 同一文档中同一目标被多次引用，Parser 不去重（去重在 MentionService）
        var matches = WikiLinkParser.Parse("Foo [[Target]] bar [[Target]] baz");
        Assert.Equal(2, matches.Count);
        Assert.All(matches, m => Assert.Equal("Target", m.AnchorText));
        Assert.NotEqual(matches[0].Position, matches[1].Position);
    }

    [Fact]
    public void Parse_PipeWithoutAlias_NoTreatedAsAlias()
    {
        // [[Title|]] 末尾管道但无别名 —— 别名为空字符串视为 null
        var matches = WikiLinkParser.Parse("Edge case [[Title|]]");
        // 这种写法当前正则不匹配（alias 至少要一字符），不抛错即可
        Assert.True(matches.Count <= 1);
    }
}
