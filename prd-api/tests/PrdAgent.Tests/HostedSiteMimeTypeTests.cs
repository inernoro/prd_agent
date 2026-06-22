using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public class HostedSiteMimeTypeTests
{
    [Theory]
    [InlineData(".jpg", "image/jpeg")]
    [InlineData(".jpeg", "image/jpeg")]
    [InlineData(".png", "image/png")]
    public void GetMimeType_maps_common_image_extensions_to_correct_content_type(string ext, string expected)
    {
        Assert.Equal(expected, HostedSiteService.GetMimeType(ext));
    }
}
