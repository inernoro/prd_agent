using PrdAgent.Infrastructure.Services.DocumentStore;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 自动补链单元测试（WikiLinkAutoLinker）。
///
/// 算法在 <see cref="WikiLinkAutoLinker"/>：在正文中查找候选标题的字面出现，
/// 把每个标题的第一处合法出现改写为 [[标题]]。保护区间（代码块 / 链接 / frontmatter /
/// 既有 [[..]] 等）内不改写；已链接过的标题整篇跳过（幂等）。
/// </summary>
public class WikiLinkAutoLinkerTests
{
    [Fact]
    public void LinkTitles_EmptyContentOrTitles_NoChange()
    {
        Assert.Equal(0, WikiLinkAutoLinker.LinkTitles(null, new[] { "标题" }).LinksAdded);
        Assert.Equal(0, WikiLinkAutoLinker.LinkTitles("正文", Array.Empty<string>()).LinksAdded);
    }

    [Fact]
    public void LinkTitles_SimpleMatch_WrapsFirstOccurrenceOnly()
    {
        var content = "本文引用了双链设计,后面再提一次双链设计。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "双链设计" });
        Assert.Equal(1, result.LinksAdded);
        Assert.Equal("本文引用了[[双链设计]],后面再提一次双链设计。", result.Content);
        Assert.Equal(new[] { "双链设计" }, result.LinkedTitles);
    }

    [Fact]
    public void LinkTitles_LongerTitleWins_ShortTitleStillLinksElsewhere()
    {
        var content = "先讲双链设计规范,再单独讲双链。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "双链", "双链设计规范" });
        // 长标题先 claim「双链设计规范」;短标题「双链」在它处首现
        Assert.Equal(2, result.LinksAdded);
        Assert.Equal("先讲[[双链设计规范]],再单独讲[[双链]]。", result.Content);
    }

    [Fact]
    public void LinkTitles_ShortTitleInsideLongClaim_NotNested()
    {
        var content = "只出现双链设计规范这一处。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "双链", "双链设计规范" });
        // 短标题「双链」唯一出现被长标题 claim 覆盖 → 不嵌套改写
        Assert.Equal(1, result.LinksAdded);
        Assert.Equal("只出现[[双链设计规范]]这一处。", result.Content);
    }

    [Fact]
    public void LinkTitles_AlreadyLinked_Idempotent()
    {
        var content = "已有[[双链设计]]链接,后文再提双链设计。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "双链设计" });
        Assert.Equal(0, result.LinksAdded);
        Assert.Equal(content, result.Content);
    }

    [Fact]
    public void LinkTitles_AlreadyLinkedWithAlias_Idempotent()
    {
        var content = "已有[[双链设计|别名]]链接,后文再提双链设计。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "双链设计" });
        Assert.Equal(0, result.LinksAdded);
    }

    [Fact]
    public void LinkTitles_SecondRunAfterRewrite_NoFurtherChange()
    {
        var first = WikiLinkAutoLinker.LinkTitles("提到双链设计的正文。", new[] { "双链设计" });
        Assert.Equal(1, first.LinksAdded);
        var second = WikiLinkAutoLinker.LinkTitles(first.Content, new[] { "双链设计" });
        Assert.Equal(0, second.LinksAdded);
        Assert.Equal(first.Content, second.Content);
    }

    [Fact]
    public void LinkTitles_FencedCodeBlock_Protected()
    {
        var content = "```\n代码里的双链设计\n```\n正文里的双链设计。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "双链设计" });
        Assert.Equal(1, result.LinksAdded);
        Assert.Equal("```\n代码里的双链设计\n```\n正文里的[[双链设计]]。", result.Content);
    }

    [Fact]
    public void LinkTitles_UnclosedFence_ProtectedToEnd()
    {
        var content = "正文提到双链设计。\n```\n未闭合代码块里的双链设计";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "双链设计" });
        Assert.Equal(1, result.LinksAdded);
        Assert.StartsWith("正文提到[[双链设计]]。", result.Content);
        Assert.EndsWith("未闭合代码块里的双链设计", result.Content);
    }

    [Fact]
    public void LinkTitles_InlineCode_Protected()
    {
        var content = "行内码 `双链设计` 不改,正文双链设计要改。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "双链设计" });
        Assert.Equal(1, result.LinksAdded);
        Assert.Equal("行内码 `双链设计` 不改,正文[[双链设计]]要改。", result.Content);
    }

    [Fact]
    public void LinkTitles_MarkdownLinkAndImage_Protected()
    {
        var content = "[双链设计](https://a.b/c) 与 ![双链设计](img.png) 都不改,正文双链设计改。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "双链设计" });
        Assert.Equal(1, result.LinksAdded);
        Assert.EndsWith("正文[[双链设计]]改。", result.Content);
        Assert.Contains("[双链设计](https://a.b/c)", result.Content);
    }

    [Fact]
    public void LinkTitles_MarkdownLinkWithParenthesizedUrl_Protected()
    {
        // URL 含括号的合法链接（维基式地址）也要整段保护,链接文本不得被改写
        var content = "[API](https://example.com/a(b)) 之外的 API 才改。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "API" });
        Assert.Equal(1, result.LinksAdded);
        Assert.Equal("[API](https://example.com/a(b)) 之外的 [[API]] 才改。", result.Content);
    }

    [Fact]
    public void LinkTitles_BareUrl_Protected()
    {
        var content = "见 https://example.com/spec.cds.md 一文,正文提 spec.cds.md 时改。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "spec.cds.md" });
        Assert.Equal(1, result.LinksAdded);
        Assert.Contains("https://example.com/spec.cds.md", result.Content);
        Assert.Contains("正文提 [[spec.cds.md]] 时改", result.Content);
    }

    [Fact]
    public void LinkTitles_Frontmatter_Protected()
    {
        var content = "---\ntitle: 双链设计\n---\n正文里的双链设计。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "双链设计" });
        Assert.Equal(1, result.LinksAdded);
        Assert.Equal("---\ntitle: 双链设计\n---\n正文里的[[双链设计]]。", result.Content);
    }

    [Fact]
    public void LinkTitles_AsciiWordBoundary_NoSubstringMatch()
    {
        var content = "MAPI is not MAP, but MAP alone matches.";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "MAP" });
        Assert.Equal(1, result.LinksAdded);
        // MAPI 内部的 MAP 不命中;独立的 MAP 命中(首个合法出现是 "not MAP," 处)
        Assert.Equal("MAPI is not [[MAP]], but MAP alone matches.", result.Content);
    }

    [Fact]
    public void LinkTitles_CandidateFiltering_ShortNumericBracketTitlesSkipped()
    {
        var content = "提到 42 和 A 和 坏[标题] 的正文。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "42", "A", "坏[标题]" });
        Assert.Equal(0, result.LinksAdded);
        Assert.Equal(content, result.Content);
    }

    [Fact]
    public void LinkTitles_MultipleTitles_EachLinkedOnce()
    {
        var content = "甲文档引用乙文档,乙文档又引用甲文档。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "甲文档", "乙文档" });
        Assert.Equal(2, result.LinksAdded);
        Assert.Equal("[[甲文档]]引用[[乙文档]],乙文档又引用甲文档。", result.Content);
    }

    [Fact]
    public void LinkTitles_TitleInsideExistingWikiLink_Protected()
    {
        var content = "已有[[双链设计规范]],正文另提双链。";
        var result = WikiLinkAutoLinker.LinkTitles(content, new[] { "双链" });
        // 「双链」在 [[双链设计规范]] 内部的出现受保护;链到后面的独立出现
        Assert.Equal(1, result.LinksAdded);
        Assert.Equal("已有[[双链设计规范]],正文另提[[双链]]。", result.Content);
    }
}
