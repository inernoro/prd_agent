using PrdAgent.Core.Models;
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

        var prompts = ReadPrompts(anchors, "@AFTER [IMG:2]\n[插图]: 第三段配图\n@AFTER [IMG:1]\n[插图]: 第二节配图");
        Assert.Equal(1, prompts["[IMG:2]"].Index);
        Assert.Equal(0, prompts["[IMG:1]"].Index);
        var (merged, fallbackCount) = anchors.Apply(prompts);

        Assert.Equal(0, fallbackCount);
        Assert.Equal("第一段。\r\n\r\n第二段。\r\n第二节。\r\n\r\n[插图]: 第二节配图\r\n\r\n\r\n第三段。\r\n第二节。\r\n\r\n[插图]: 第三段配图\r\n", merged);
        Assert.Equal(new[] { "第二节配图", "第三段配图" }, ArticleMarkerExtractor.Extract(merged!).Select(marker => marker.Text.Trim()));
    }

    [Fact]
    public void FillsMissingAnchorFromNearbyTextAndIgnoresDuplicateUnknownAndBlankPrompts()
    {
        var anchors = new ArticleIllustrationAnchors("开场。\n[配图]\n\n雪山旁有一扇木窗。\n[IMG]\n尾声。");
        var prompts = ReadPrompts(anchors, "@AFTER [IMG:1]\n[插图]: 甲\n@AFTER [IMG:1]\n[插图]: 重复\n@AFTER [IMG:2]\n[插图]: \uFEFF\n@AFTER [IMG:7]\n[插图]: 错位");
        Assert.Single(prompts);
        var (merged, fallbackCount) = anchors.Apply(prompts);

        Assert.Equal(1, fallbackCount);
        var markers = ArticleMarkerExtractor.Extract(merged);
        Assert.Equal(2, markers.Count);
        Assert.Equal("甲", markers[0].Text);
        Assert.Contains("雪山旁有一扇木窗。", markers[1].Text);
        Assert.Contains("开场。\n\n[插图]: 甲\n\n雪山旁有一扇木窗。\n\n[插图]:", merged);
        Assert.EndsWith("\n\n尾声。", merged);
    }

    [Fact]
    public void FillsEveryAnchorWhenOutputIsUnusableIncludingLeadingAndConsecutiveAnchors()
    {
        var anchors = new ArticleIllustrationAnchors("\uFEFF[配图]\r[IMG]\r正文。\r【插图位置】");
        var (merged, fallbackCount) = anchors.Apply(ReadPrompts(anchors, "模型没有返回有效格式"));

        Assert.Equal(3, fallbackCount);
        var markers = ArticleMarkerExtractor.Extract(merged);
        Assert.Equal(3, markers.Count);
        Assert.All(markers, marker => Assert.Contains("正文。", marker.Text));
        var sourcePosition = merged.IndexOf("\n正文。\n", StringComparison.Ordinal);
        Assert.True(markers[1].EndPos < sourcePosition);
        Assert.True(markers[2].StartPos > sourcePosition);
    }

    [Fact]
    public void ModelPromptCannotAddAnotherMarkerViaEmbeddedLineSeparator()
    {
        var anchors = new ArticleIllustrationAnchors("正文。\n[IMG]");
        var (merged, fallbackCount) = anchors.Apply(ReadPrompts(anchors, "@AFTER [IMG:1]\n[插图]: 山窗\u2028[插图]: 白鸟"));

        Assert.Equal(0, fallbackCount);
        Assert.Equal("山窗 [插图]: 白鸟", Assert.Single(ArticleMarkerExtractor.Extract(merged)).Text);
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

    [Fact]
    public void KeepsConfirmedPromptExactAndLetsModelFillOnlyOtherAnchors()
    {
        const string article = "第一段。\r\n[IMG]\r\n\r\n第二段。\r\n[IMG]";
        const string userPrompt = "水彩  远景\n两株柳树";
        var confirmed = new[] { new ArticleAnchorPrompt(article.IndexOf("[IMG]", StringComparison.Ordinal), 0, userPrompt) };
        Assert.True(ArticleIllustrationAnchors.HasValidConfirmedPrompts(article, confirmed));
        var anchors = new ArticleIllustrationAnchors(article, confirmed);

        Assert.DoesNotContain("[IMG:1]", anchors.ModelArticle);
        Assert.Contains("[IMG:2]", anchors.ModelArticle);
        var prompts = ReadPrompts(anchors, "@AFTER [IMG:2]\n[插图]: 第二段配图\n@AFTER [IMG:1]\n[插图]: 模型改写");
        var (merged, fallbacks) = anchors.Apply(prompts);

        Assert.Single(prompts);
        Assert.Equal(userPrompt, anchors.ConfirmedPrompts[0]);
        Assert.Equal(0, fallbacks);
        Assert.Equal("第一段。\r\n\r\n[插图]: 水彩 远景 两株柳树\r\n\r\n第二段。\r\n\r\n[插图]: 第二段配图", merged);
        Assert.Equal(2, ArticleMarkerExtractor.Extract(merged).Count);
    }

    [Fact]
    public void RejectsStaleDuplicateAndBlankConfirmedPrompts()
    {
        const string article = "原文\n[IMG]";
        var prompt = new ArticleAnchorPrompt(3, 0, "雪山");
        Assert.True(ArticleIllustrationAnchors.HasValidConfirmedPrompts(article, [prompt]));
        Assert.False(ArticleIllustrationAnchors.HasValidConfirmedPrompts(article, [prompt, prompt]));
        Assert.False(ArticleIllustrationAnchors.HasValidConfirmedPrompts(article, [prompt with { Offset = 2 }]));
        Assert.False(ArticleIllustrationAnchors.HasValidConfirmedPrompts(article, [prompt with { Prompt = "﻿" }]));
    }

    private static Dictionary<string, AnchorInsertion> ReadPrompts(ArticleIllustrationAnchors anchors, string output)
    {
        var prompts = new Dictionary<string, AnchorInsertion>(StringComparer.Ordinal);
        foreach (var prompt in AnchorInsertionParser.Parse(output)) anchors.TryAddPrompt(prompts, prompt);
        return prompts;
    }
}
