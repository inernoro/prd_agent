using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Tests;

public sealed class HostedSiteDeletionContractTests
{
    [Theory]
    [InlineData("web-hosting/sites/0123456789abcdef0123456789abcdef/index.html", null, true)]
    [InlineData("data/web-hosting/sites/0123456789abcdef0123456789abcdef/assets/app.js", "data", true)]
    [InlineData("data/web-hosting/sites/0123456789ABCDEF0123456789ABCDEF/index.v123.html", "data", true)]
    [InlineData("web-hosting/sites/0123456789abcdef0123456789abcdef", null, false)]
    [InlineData("web-hosting/sites/0123456789abcdef0123456789abcdef/", null, false)]
    [InlineData("web-hosting/sites/not-a-site/index.html", null, false)]
    [InlineData("web-hosting/sites/0123456789abcdef0123456789abcdef/../other.html", null, false)]
    [InlineData("web-hosting/sites/0123456789abcdef0123456789abcdef/assets//app.js", null, false)]
    [InlineData("web-hosting/sites/0123456789abcdef0123456789abcdef2/index.html", null, false)]
    [InlineData("other/sites/0123456789abcdef0123456789abcdef/index.html", null, false)]
    public void DeletePolicy_ShouldOnlyAllowOneFileWithinAnExactHostedSite(
        string key,
        string? prefix,
        bool expected)
    {
        Assert.Equal(expected, AssetStorageDeletePolicy.IsHostedSiteFileKey(key, prefix));
    }
}
