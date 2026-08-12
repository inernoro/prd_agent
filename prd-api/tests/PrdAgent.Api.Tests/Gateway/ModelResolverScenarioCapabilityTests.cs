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

        var differentScenario = requiredCapability == "text2img" ? "img2img" : "text2img";
        logical.Capabilities = ["image_generation", differentScenario];
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

    [Theory]
    [InlineData("visual-agent.image.text2img::generation")]
    [InlineData("visual-agent.image.img2img::generation")]
    [InlineData("visual-agent.image.vision::generation")]
    public void LegacyGenericImageCapability_RemainsCompatibleUntilBackfill(string appCallerCode)
    {
        var logical = new GatewayLogicalModel
        {
            Capabilities = ["image_generation"],
        };

        Assert.True(ModelResolver.SupportsAppCallerScenario(logical, appCallerCode));
    }

    [Fact]
    public void AnyExplicitImageScenario_DisablesLegacyGenericFallback()
    {
        var logical = new GatewayLogicalModel
        {
            Capabilities = ["image_generation", "text2img"],
        };

        Assert.False(ModelResolver.SupportsAppCallerScenario(
            logical,
            "visual-agent.image.img2img::generation"));
    }

    [Theory]
    [InlineData("visual-agent.image.text2img::generation")]
    [InlineData("visual-agent.image.img2img::generation")]
    [InlineData("visual-agent.image.vision::generation")]
    public void ImageLayeringCapability_NeverEntersGeneralGenerationScenarios(string appCallerCode)
    {
        var logical = new GatewayLogicalModel
        {
            // 包含历史误配置的通用能力，仍必须由分层专用 appCaller 隔离。
            Capabilities = ["image_generation", "image_layering", "text2img", "img2img", "vision_generation"],
        };

        Assert.False(ModelResolver.SupportsAppCallerScenario(logical, appCallerCode));
        Assert.True(ModelResolver.SupportsAppCallerScenario(
            logical,
            AppCallerRegistry.VisualAgent.Image.Layering));
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
