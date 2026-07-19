using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public sealed class ModelResolutionTypeMapperTests
{
    [Theory]
    [InlineData("GatewayRegistryPool", ModelResolutionType.DedicatedPool)]
    [InlineData("DedicatedPool", ModelResolutionType.DedicatedPool)]
    [InlineData("DefaultPool", ModelResolutionType.DefaultPool)]
    [InlineData("DirectModel", ModelResolutionType.DirectModel)]
    [InlineData("Legacy", ModelResolutionType.Legacy)]
    public void Parse_ShouldMapServingResolutionToLogResolution(
        string servingResolution,
        ModelResolutionType expected)
    {
        Assert.Equal(expected, ModelResolutionTypeMapper.Parse(servingResolution));
    }

    [Fact]
    public void Parse_ShouldReturnNullForUnknownResolution()
    {
        Assert.Null(ModelResolutionTypeMapper.Parse("Unknown"));
    }
}
