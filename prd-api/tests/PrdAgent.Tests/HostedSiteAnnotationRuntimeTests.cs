using System.Text;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public class HostedSiteAnnotationRuntimeTests
{
    [Fact]
    public void Republishing_UsesExactlyOneCurrentRuntimeBeforeBodyCloses()
    {
        const string html = "<html><body><main>正文</main></body></html>";
        var first = HostedSiteAnnotationRuntime.Inject(html);
        var second = HostedSiteAnnotationRuntime.Inject(first);
        Assert.Equal(first, second);
        Assert.Single(second.Split("data-map-annotations=\"v1\"").Skip(1));
        Assert.True(second.IndexOf("data-map-annotations", StringComparison.Ordinal)
            < second.IndexOf("</body>", StringComparison.Ordinal));
        Assert.Equal(html, HostedSiteAnnotationRuntime.Strip(second));
    }

    [Fact]
    public void DeclarativePublication_RemovesHistoricalAnnotationScripts()
    {
        const string html = "<html data-map-artifact-mode='declarative-only'><body>正文<script data-map-annotations='v0'>old()</script></body></html>";
        var rewritten = Encoding.UTF8.GetString(HostedSiteService.RewritePublishedEntryHtml(Encoding.UTF8.GetBytes(html), "index.html"));
        Assert.DoesNotContain("<script", rewritten, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("正文", rewritten);
    }
}
