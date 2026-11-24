using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class VisualLogicalModelBoundaryTests
{
    [Theory]
    [InlineData(AppCallerRegistry.VisualAgent.Image.Text2Img, true)]
    [InlineData(AppCallerRegistry.VisualAgent.Image.Img2Img, true)]
    [InlineData(AppCallerRegistry.VisualAgent.Image.VisionGen, true)]
    [InlineData("visual-agent.storyboard::chat", false)]
    [InlineData("other-agent.image::generation", false)]
    public void CatalogPolicy_OnlyAppliesToVisualGeneration(string caller, bool expected)
        => Assert.Equal(expected, ModelResolver.UsesVisualLogicalModelCatalog(caller));

    [Theory]
    [InlineData("allowed-platform", "chosen-model", ModelHealthStatus.Healthy, true)]
    [InlineData("allowed-platform", "chosen-model", ModelHealthStatus.Degraded, true)]
    [InlineData("allowed-platform", "chosen-model", ModelHealthStatus.Unavailable, false)]
    [InlineData("other-platform", "chosen-model", ModelHealthStatus.Healthy, false)]
    [InlineData("allowed-platform", "other-model", ModelHealthStatus.Healthy, false)]
    public void LogicalOffering_CannotEscapeAuthorizedPoolMembers(
        string platform, string model, ModelHealthStatus health, bool expected)
    {
        var resolution = new ModelResolutionResult
        {
            ActualPlatformId = platform,
            ActualModel = model,
        };
        var groups = new[]
        {
            new ModelGroup
            {
                Models = [new ModelGroupItem
                {
                    PlatformId = "allowed-platform", ModelId = "chosen-model", HealthStatus = health,
                }],
            },
        };
        Assert.Equal(expected, ModelResolver.IsLogicalOfferingAllowed(resolution, groups));
    }

    [Fact]
    public void EmptyAuthorization_FailsClosed_WhileLegacyRetainsLogicalAuthorization()
    {
        var resolution = new ModelResolutionResult();
        Assert.False(ModelResolver.IsLogicalOfferingAllowed(resolution, []));
        Assert.True(ModelResolver.IsLogicalOfferingAllowed(resolution, null));
    }
}
