using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class SafeOutboundUrlValidatorTests
{
    private readonly SafeOutboundUrlValidator _validator = new();

    [Theory]
    [InlineData("http://127.0.0.1:5000")]
    [InlineData("http://10.0.0.1")]
    [InlineData("http://172.16.0.1")]
    [InlineData("http://192.168.1.10")]
    [InlineData("http://169.254.169.254/latest/meta-data")]
    [InlineData("http://localhost:5000")]
    [InlineData("ftp://example.com/file")]
    public async Task EnsureSafeHttpUrlAsync_BlocksUnsafeTargets(string url)
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            _validator.EnsureSafeHttpUrlAsync(url, "测试"));
    }

    [Fact]
    public async Task EnsureSafeHttpUrlAsync_AllowsPublicHttpLiteral()
    {
        var uri = await _validator.EnsureSafeHttpUrlAsync("https://93.184.216.34/path", "测试");

        Assert.Equal("https", uri.Scheme);
        Assert.Equal("93.184.216.34", uri.Host);
    }

    [Fact]
    public void IsSafeAddress_BlocksMetadataAddressAtConnectTime()
    {
        Assert.False(_validator.IsSafeAddress(System.Net.IPAddress.Parse("169.254.169.254")));
        Assert.True(_validator.IsSafeAddress(System.Net.IPAddress.Parse("93.184.216.34")));
    }
}
