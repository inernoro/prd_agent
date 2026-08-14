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
    public void OpenRouterImageRequest_RoutesAllReferencesThroughDedicatedImagesProtocol()
    {
        var request = OpenAIImageClient.BuildOpenRouterImageRequest(
            "google/gemini-image",
            "参考两张图片生成",
            1,
            "1024x1024",
            ["data:image/png;base64,first", "data:image/jpeg;base64,second"],
            isAdaptiveModel: false);

        Assert.Equal("images", request.EndpointPath);
        Assert.Equal(1, request.Body["n"]?.GetValue<int>());
        Assert.Equal("1024x1024", request.Body["size"]?.GetValue<string>());
        Assert.Equal(2, request.Body["input_references"]?.AsArray().Count);
    }

    [Fact]
    public void OpenRouterImageRequest_OmitsCountAndSizeForAdaptiveModels()
    {
        var request = OpenAIImageClient.BuildOpenRouterImageRequest(
            "gpt-image-2-all",
            "生成自适应图片",
            3,
            "1536x1024",
            ["raw-base64"],
            isAdaptiveModel: true);

        Assert.False(request.Body.ContainsKey("n"));
        Assert.False(request.Body.ContainsKey("size"));
        Assert.Equal(1, request.Body["input_references"]?.AsArray().Count);
        Assert.Equal(
            "data:image/png;base64,raw-base64",
            request.Body["input_references"]?[0]?["image_url"]?["url"]?.GetValue<string>());
    }

    [Theory]
    [InlineData("openai", "gpt-image-1.5", true)]
    [InlineData("openai-compatible", "gpt-image-2", true)]
    [InlineData("openrouter-image", "openai/gpt-image-2", false)]
    [InlineData("openai", "gemini-2.5-flash-image", false)]
    public void MultiImageRouting_UsesDedicatedEditApiOnlyForDeclaredOpenAIImageModels(
        string protocol,
        string model,
        bool expected)
    {
        Assert.Equal(expected, OpenAIImageClient.ShouldUseOpenAIImagesEditApi(protocol, model));
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
