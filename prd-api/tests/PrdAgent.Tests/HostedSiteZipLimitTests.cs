using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public class HostedSiteZipLimitTests
{
    [Fact]
    public void ZipFileCountLimit_allows_static_site_builds_with_many_small_assets()
    {
        Assert.Equal(5000, HostedSiteService.MaxZipFileCount);
    }
}
