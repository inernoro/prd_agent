using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public class AiNewsFeedEndpointTests
{
    [Fact]
    public void FeedUrl_targets_the_canonical_https_endpoint_without_redirect()
    {
        var uri = new Uri(AiNewsService.FeedUrl);

        Assert.Equal(Uri.UriSchemeHttps, uri.Scheme);
        Assert.Equal("news.learnprompt.pro", uri.Host);
        Assert.Equal("/data/latest-24h.json", uri.AbsolutePath);
    }
}
