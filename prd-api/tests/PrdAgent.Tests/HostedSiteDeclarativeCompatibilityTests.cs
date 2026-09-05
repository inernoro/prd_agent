using System.Text;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public sealed class HostedSiteDeclarativeCompatibilityTests
{
    [Fact]
    public void PublishingStrictCspArtifact_ShouldNotInjectSlideCompatibilityScript()
    {
        const string html = """
            <!doctype html><html><head>
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src data:">
            </head><body><main>安全页面</main></body></html>
            """;

        var rewritten = Encoding.UTF8.GetString(
            HostedSiteService.RewritePublishedEntryHtml(Encoding.UTF8.GetBytes(html), "index.html"));

        Assert.DoesNotContain("map-slide-nav-compat", rewritten, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<script", rewritten, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("script-src 'none'", rewritten, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RepublishingPreviouslyContaminatedStrictCspArtifact_ShouldRemoveOldCompatibilityScript()
    {
        const string html = """
            <!doctype html><html><head>
            <meta content="default-src 'none'; script-src 'none'" http-equiv="Content-Security-Policy">
            </head><body><main>安全页面</main><!--map-slide-nav-compat--><script>window.__mapSlideNavCompat=true;</script></body></html>
            """;

        var rewritten = Encoding.UTF8.GetString(
            HostedSiteService.RewritePublishedEntryHtml(Encoding.UTF8.GetBytes(html), "nested/index.html"));

        Assert.DoesNotContain("map-slide-nav-compat", rewritten, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<script", rewritten, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("script-src 'none'", rewritten, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ExplicitDeclarativeMarker_ShouldSkipCompatibilityWithoutTreatingLooseCspAsSafe()
    {
        Assert.True(HostedSiteService.HasDeclarativeOnlyPolicy(
            "<html data-map-artifact-mode='declarative-only'><body></body></html>"));
        Assert.False(HostedSiteService.HasDeclarativeOnlyPolicy(
            "<html><head><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; script-src 'self'\"></head></html>"));
    }
}
