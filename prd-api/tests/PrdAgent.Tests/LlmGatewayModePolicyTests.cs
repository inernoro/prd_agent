using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

public sealed class LlmGatewayModePolicyTests
{
    [Fact]
    public void Resolve_ProductionMissingMode_ShouldFailClosed()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            LlmGatewayModePolicy.Resolve(null, isProduction: true));

        Assert.Contains("生产必须显式设置", error.Message);
    }

    [Theory]
    [InlineData("http", "http")]
    [InlineData(" SHADOW ", "shadow")]
    [InlineData("INPROC", "inproc")]
    public void Resolve_ExplicitAllowedMode_ShouldNormalize(string configured, string expected)
    {
        Assert.Equal(expected, LlmGatewayModePolicy.Resolve(configured, isProduction: true));
    }

    [Fact]
    public void Resolve_DevelopmentMissingMode_ShouldKeepLocalInprocDefault()
    {
        Assert.Equal("inproc", LlmGatewayModePolicy.Resolve(string.Empty, isProduction: false));
    }

    [Fact]
    public void Resolve_InvalidMode_ShouldReject()
    {
        Assert.Throws<InvalidOperationException>(() =>
            LlmGatewayModePolicy.Resolve("auto", isProduction: false));
    }
}
