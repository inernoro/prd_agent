using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class ModelResolverScenarioCapabilityTests
{
    [Theory]
    [InlineData("visual-agent.image.text2img::generation", "text2img")]
    [InlineData("literary-agent.illustration.img2img::generation", "img2img")]
    [InlineData("visual-agent.image.vision::generation", "vision_generation")]
    public void ScenarioSpecificImageCaller_RequiresMatchingCapability(
        string appCallerCode,
        string requiredCapability)
    {
        var logical = new GatewayLogicalModel
        {
            Capabilities = ["image_generation", requiredCapability],
        };

        Assert.True(ModelResolver.SupportsAppCallerScenario(logical, appCallerCode));

        logical.Capabilities = ["image_generation", "image_layering"];
        Assert.False(ModelResolver.SupportsAppCallerScenario(logical, appCallerCode));
    }

    [Fact]
    public void ExplicitAllowlist_RemainsRequiredInAdditionToScenarioCapability()
    {
        var logical = new GatewayLogicalModel
        {
            Capabilities = ["image_generation", "text2img"],
            AllowedAppCallerCodes = ["another.image.text2img::generation"],
        };

        Assert.False(ModelResolver.SupportsAppCallerScenario(
            logical,
            "visual-agent.image.text2img::generation"));
    }

    [Fact]
    public void NonImageCaller_DoesNotGainAnInventedCapabilityRequirement()
    {
        var logical = new GatewayLogicalModel
        {
            Capabilities = ["chat"],
        };

        Assert.True(ModelResolver.SupportsAppCallerScenario(logical, "map.chat::chat"));
    }
}
