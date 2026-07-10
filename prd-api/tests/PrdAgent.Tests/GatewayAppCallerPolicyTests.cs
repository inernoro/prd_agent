using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

public sealed class GatewayAppCallerPolicyTests
{
    [Theory]
    [InlineData(null, "discovered")]
    [InlineData(" DISCOVERED ", "discovered")]
    [InlineData("Configured", "configured")]
    [InlineData("ACTIVE", "active")]
    public void NormalizeStatus_ShouldReturnStableGovernanceValue(string? input, string expected)
    {
        Assert.Equal(expected, GatewayAppCallerPolicy.NormalizeStatus(input));
    }

    [Theory]
    [InlineData("discovered", true)]
    [InlineData("configured", true)]
    [InlineData("active", true)]
    [InlineData("disabled", false)]
    [InlineData("archived", false)]
    [InlineData("unexpected", false)]
    public void AllowsTraffic_ShouldFailClosedForDisabledArchivedAndUnknown(string status, bool expected)
    {
        Assert.Equal(expected, GatewayAppCallerPolicy.AllowsTraffic(status));
    }
}
