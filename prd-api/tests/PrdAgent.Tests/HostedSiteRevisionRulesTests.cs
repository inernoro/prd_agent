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
    public void ValidateHtml_RejectsEmptyOrNonHtml(string html)
    {
        Assert.Throws<InvalidOperationException>(() => HostedSiteRevisionRules.ValidateHtml(html));
    }
}
