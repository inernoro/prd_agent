using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class HostedSiteRevisionRulesTests
{
    [Fact]
    public void NormalizeGeneratedHtml_RemovesMarkdownFence()
    {
        var result = HostedSiteRevisionRules.NormalizeGeneratedHtml(
            "```html\n<!doctype html><html><body>新版</body></html>\n```");

        Assert.Equal("<!doctype html><html><body>新版</body></html>", result);
    }

    [Theory]
    [InlineData("<!doctype html><html><body></body></html>")]
    [InlineData("<html><body>页面</body></html>")]
    public void ValidateHtml_AcceptsCompletePage(string html)
    {
        HostedSiteRevisionRules.ValidateHtml(html);
    }

    [Theory]
    [InlineData("")]
    [InlineData("只有一段解释文字")]
    [InlineData("<!doctype html><body>implicit root bypass</body>")]
    [InlineData("<!doctype html><!-- <html> --><body>comment root bypass</body>")]
    [InlineData("<!doctype html><html data-breakout=\"<\"><body>quoted root delimiter</body></html>")]
    public void ValidateHtml_RejectsEmptyOrNonHtml(string html)
    {
        Assert.Throws<InvalidOperationException>(() => HostedSiteRevisionRules.ValidateHtml(html));
    }

    [Fact]
    public void HardenGeneratedHtml_BlocksScriptsAndExternalReferences()
    {
        var unsafePages = new[]
        {
            "<!doctype html><html><script>globalThis['lo'+'cation']='https://outside.example'</script></html>",
            "<!doctype html><html><img src=\"https://outside.example/pixel\"></html>",
            "<!doctype html><html><a href=\"https://outside.example\">leave</a></html>",
            "<!doctype html><html><style>body{background:url(https://outside.example/pixel)}</style></html>",
            "<!doctype html><html><form action=\"/submit\"></form></html>",
            "<!doctype html><html><body background=\"https://tracker.example/pixel.png\"></body></html>",
            "<!doctype html><html><video poster=\"https://tracker.example/poster.png\"></video></html>",
            "<!doctype html><html><a href=\"#ok\" ping=\"https://tracker.example/ping\">leave</a></html>",
        };

        foreach (var html in unsafePages)
            Assert.Throws<InvalidOperationException>(() => HostedSiteRevisionRules.HardenGeneratedHtml(html));
    }

    [Theory]
    [InlineData("<!doctype html><html><head><meta http-equiv=\"re&#102;resh\" content=\"0;url=https://outside.example\"></head></html>")]
    [InlineData("<!doctype html><html><head><meta content=\"custom\" http-equiv=\"x-product-mode\"></head></html>")]
    [InlineData("<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"></head></html>")]
    public void HardenGeneratedHtml_RejectsEveryUserProvidedHttpEquivMeta(string html)
    {
        Assert.Throws<InvalidOperationException>(() => HostedSiteRevisionRules.HardenGeneratedHtml(html));
    }

    [Fact]
    public void HardenGeneratedHtml_ConvertsRelativeKnowledgeLinkIntoInertCitation()
    {
        var result = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html lang=\"zh-CN\"><head><title>阅读地图</title></head><body><a class=\"link\" href=\"./guide.platform.quickstart.md\">快速开始</a></body></html>");

        Assert.Contains("script-src 'none'", result);
        Assert.DoesNotContain("frame-ancestors", result);
        Assert.DoesNotContain("navigate-to", result);
        Assert.Contains("<span data-cds-source-reference=\"./guide.platform.quickstart.md\">快速开始</span>", result);
        Assert.DoesNotContain("href=\"./guide.platform.quickstart.md\"", result);
    }

    [Fact]
    public void HardenGeneratedHtml_InjectsCspBeforeACommentThatPretendsToBeHead()
    {
        var result = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html><!--<head>--><style>body{background-image:u\\72l(https://tracker.example/p)}</style><body>ok</body></html>");

        Assert.True(
            result.IndexOf("Content-Security-Policy", StringComparison.Ordinal)
            < result.IndexOf("<!--<head>-->", StringComparison.Ordinal));
        Assert.Contains("img-src data:", result, StringComparison.Ordinal);
    }
}
