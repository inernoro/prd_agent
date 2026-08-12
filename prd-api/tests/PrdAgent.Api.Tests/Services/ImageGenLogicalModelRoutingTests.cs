using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ImageGenLogicalModelRoutingTests
{
    [Theory]
    [InlineData("image2", "legacy", "ignored", "ignored", "image2")]
    [InlineData(null, "logical-model", "image2", null, "image2")]
    [InlineData(null, "LOGICAL-MODEL", "fallback-id", "nanobanana-2", "nanobanana-2")]
    [InlineData(null, "legacy-platform", "image2", "image2", "")]
    public void ImageClient_RecoversRequiredLogicalModelFromStablePlatformMarker(
        string? required,
        string? platformId,
        string? modelId,
        string? modelName,
        string expected)
    {
        Assert.Equal(expected, OpenAIImageClient.ResolveRequiredLogicalModelPublicId(
            required, platformId, modelId, modelName));
    }

    [Fact]
    public void ResolveExplicitLogicalModelPublicId_PrefersPersistedStableIdentity()
    {
        var run = new ImageGenRun
        {
            PlatformId = "provider-after-old-scheduling",
            ModelId = "upstream/model-after-old-scheduling",
            LogicalModelPublicId = "nanobanana-2",
        };

        var result = ImageGenRunWorker.ResolveExplicitLogicalModelPublicId(run);

        Assert.Equal("nanobanana-2", result);
    }

    [Fact]
    public void ResolveExplicitLogicalModelPublicId_RecoversIdentityFromLogicalPlatformMarker()
    {
        var run = new ImageGenRun
        {
            PlatformId = "LOGICAL-MODEL",
            ModelId = " image2 ",
        };

        var result = ImageGenRunWorker.ResolveExplicitLogicalModelPublicId(run);

        Assert.Equal("image2", result);
    }

    [Fact]
    public void ResolveExplicitLogicalModelPublicId_DoesNotTreatLegacyPoolModelAsLogical()
    {
        var run = new ImageGenRun
        {
            PlatformId = "openrouter.ai",
            ModelId = "google/gemini-3.1-flash-image",
        };

        var result = ImageGenRunWorker.ResolveExplicitLogicalModelPublicId(run);

        Assert.Null(result);
    }

    [Fact]
    public void ResolveEffectiveIsAdaptive_PrefersConfiguredPromptCapability()
    {
        var resolution = new GatewayModelResolution
        {
            ParameterCapabilities = new Dictionary<string, bool>
            {
                ["image_size.prompt"] = true,
                ["image_size.field.size"] = true,
            },
        };

        Assert.True(OpenAIImageClient.ResolveEffectiveIsAdaptive(resolution, "plain-image-model"));
    }

    [Fact]
    public void ResolveEffectiveIsAdaptive_ConfiguredNoneOverridesLegacyAdaptiveAdapter()
    {
        var resolution = new GatewayModelResolution
        {
            ParameterCapabilities = new Dictionary<string, bool>
            {
                ["image_size.none"] = true,
            },
        };

        Assert.False(OpenAIImageClient.ResolveEffectiveIsAdaptive(resolution, "gpt-image-2-all"));
    }
}
