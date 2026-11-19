using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Prompts.Templates;
using Xunit;

namespace PrdAgent.Tests;

public class ArticleIllustrationAnchorsTests
{
    [Fact]
    public void InsertsPromptsInSourceOrderAtRepeatedParagraphs()
    {
        const string article = "第一段。\r\n\r\n第二段。\r\n第二节。\r\n   [IMG]\r\n\r\n\r\n第三段。\r\n第二节。\r\n\r\n【插图位置】\r\n";
        var anchors = new ArticleIllustrationAnchors(article);
        Assert.Equal(2, anchors.Count);
        Assert.Contains("第二节。\r\n[IMG:1]", anchors.ModelArticle);

        var prompts = Parse("@AFTER [IMG:2]\n[插图]: 第三段配图\n@AFTER [IMG:1]\n[插图]: 第二节配图");
        var merged = anchors.Apply(prompts);

        Assert.Equal("第一段。\r\n\r\n第二段。\r\n第二节。\r\n\r\n[插图]: 第二节配图\r\n\r\n\r\n第三段。\r\n第二节。\r\n\r\n[插图]: 第三段配图\r\n", merged);
        Assert.Equal(new[] { "第二节配图", "第三段配图" }, ArticleMarkerExtractor.Extract(merged!).Select(marker => marker.Text.Trim()));
    }

    [Fact]
    public void LeavesWorkflowUnusableUntilEveryExplicitAnchorHasAPrompt()
    {
        var anchors = new ArticleIllustrationAnchors("[配图]\n[IMG]\n正文。");
        Assert.Null(anchors.Apply(Parse("@AFTER [IMG:1]\n[插图]: 甲\n@AFTER 正文。\n[插图]: 错位")));
        Assert.False(anchors.Contains("正文。"));

        var merged = anchors.Apply(Parse("@AFTER [IMG:1]\n[插图]: 甲\n@AFTER [IMG:2]\n[插图]: 乙"));
        Assert.Contains("[插图]: 甲\n\n", merged);
        Assert.EndsWith("[插图]: 乙\n\n正文。", merged);
    }

    [Fact]
    public void ExplicitModelInstructionsUseNumberedPlaceholders()
    {
        var prompt = ArticleIllustrationPrompt.WrapForAnchorMode("水彩风格", useUserAnchors: true);
        Assert.Contains("[IMG:1]", prompt);
        Assert.Contains("水彩风格", prompt);
        Assert.Contains("紧邻正文", prompt);
        Assert.DoesNotContain("约每 300-500 字一张", prompt);
        Assert.Contains("原文中的一句话", ArticleIllustrationPrompt.WrapForAnchorMode(""));
    }

    [Fact]
    public void AutomaticAnchorMapsNormalizedTextToExactLastLine()
    {
        var article = $"开头。\n\n第二段   跨行\n继续。\n第三段。\n{new string('\n', 200)}结尾。";
        var prompts = AnchorInsertionParser.Parse("@AFTER 第二段 跨行 继续.\n[插图]: 第二段配图");
        var result = AnchorInsertionService.Apply(article, prompts);
        Assert.Contains("继续。\n\n[插图]: 第二段配图\n\n第三段。", result.MergedContent);
    }

    private static Dictionary<string, AnchorInsertion> Parse(string output)
        => AnchorInsertionParser.Parse(output).ToDictionary(prompt => prompt.AnchorText);
}
