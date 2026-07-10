using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

public sealed class GatewayModelHealthOwnershipTests
{
    [Theory]
    [InlineData("GatewayRegistryPool", true)]
    [InlineData("DedicatedPool", false)]
    [InlineData("DefaultPool", false)]
    [InlineData("Legacy", false)]
    [InlineData("PinnedModel", false)]
    public void IsGatewayOwnedResolution_ShouldSelectTheOwningDatabase(string resolutionType, bool expected)
    {
        Assert.Equal(expected, ModelResolver.IsGatewayOwnedResolution(new ModelResolutionResult
        {
            ResolutionType = resolutionType,
        }));
    }
}
