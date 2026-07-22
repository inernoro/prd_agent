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
    [InlineData("http://192.0.2.1")]
    [InlineData("http://198.18.0.1")]
    [InlineData("http://198.51.100.1")]
    [InlineData("http://203.0.113.1")]
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

    [Theory]
    [InlineData("0.0.0.0")]
    [InlineData("100.64.0.1")]
    [InlineData("192.0.0.1")]
    [InlineData("192.0.2.1")]
    [InlineData("198.18.0.1")]
    [InlineData("198.51.100.1")]
    [InlineData("203.0.113.1")]
    [InlineData("224.0.0.1")]
    [InlineData("240.0.0.1")]
    [InlineData("64:ff9b::10.0.0.1")]
    [InlineData("64:ff9b:1::1")]
    [InlineData("100::1")]
    [InlineData("100:0:0:1::1")]
    [InlineData("2001:db8::1")]
    [InlineData("2002:a00:1::")]
    [InlineData("3fff::1")]
    [InlineData("5f00::1")]
    [InlineData("fc00::1")]
    [InlineData("fe80::1")]
    [InlineData("ff02::1")]
    public void IsSafeAddress_BlocksSpecialPurposeAndReservedRanges(string address)
    {
        Assert.False(_validator.IsSafeAddress(System.Net.IPAddress.Parse(address)));
    }

    [Theory]
    [InlineData("1.1.1.1")]
    [InlineData("93.184.216.34")]
    [InlineData("192.0.0.9")]
    [InlineData("192.0.0.10")]
    [InlineData("192.31.196.1")]
    [InlineData("192.52.193.1")]
    [InlineData("192.175.48.1")]
    [InlineData("2001:1::1")]
    [InlineData("2001:3::1")]
    [InlineData("2001:4:112::1")]
    [InlineData("2001:20::1")]
    [InlineData("2001:30::1")]
    [InlineData("2606:4700:4700::1111")]
    public void IsSafeAddress_AllowsGloballyRoutableAddresses(string address)
    {
        Assert.True(_validator.IsSafeAddress(System.Net.IPAddress.Parse(address)));
    }

    [Theory]
    [InlineData("ws://93.184.216.34/asr")]
    [InlineData("wss://127.0.0.1/asr")]
    [InlineData("wss://10.0.0.8/asr")]
    [InlineData("wss://169.254.169.254/latest/meta-data")]
    [InlineData("wss://198.18.0.1/asr")]
    [InlineData("wss://198.51.100.1/asr")]
    [InlineData("wss://203.0.113.1/asr")]
    [InlineData("wss://user:secret@93.184.216.34/asr")]
    public async Task SafeWebSocket_PrepareBlocksInsecurePrivateAndCredentialTargets(string url)
    {
        var connector = new SafeOutboundWebSocketConnector(_validator);

        await Assert.ThrowsAsync<InvalidOperationException>(() => connector.PrepareAsync(url));
    }

    [Fact]
    public async Task SafeWebSocket_PreparePinsPublicLiteralWithoutChangingCertificateHost()
    {
        var connector = new SafeOutboundWebSocketConnector(_validator);

        var target = await connector.PrepareAsync("wss://93.184.216.34:443/asr");

        Assert.Equal("wss", target.Uri.Scheme);
        Assert.Equal("93.184.216.34", target.Uri.IdnHost);
        Assert.Single(target.Addresses);
        Assert.Equal("93.184.216.34", target.Addresses[0].ToString());
    }
}
