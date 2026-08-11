using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LLM.Adapters;
using PrdAgent.Core.Models;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Xunit;

namespace PrdAgent.Tests;

public class ImageGenAdaptiveSizePromptTests
{
    [Fact]
    public void BuildGenerationBody_PromptTransportModel_InjectsSelectedPortraitSizeAndOmitsSizeField()
    {
        var requestParams = ImageGenModelAdapterRegistry.BuildRequestParams("gpt-image-2-all", "768x1024");

        var body = Assert.IsType<Dictionary<string, object>>(ImageGenRequestBuilder.BuildGenerationBody(
            "gpt-image-2-all",
            "生成商品海报",
            1,
            requestParams,
            normalizedSize: null,
            effectiveResponseFormat: null,
            new OpenAIPlatformAdapter()));

        var prompt = Assert.IsType<string>(body["prompt"]);
        Assert.StartsWith("[输出尺寸要求 / OUTPUT SIZE，最高优先级]", prompt);
        Assert.Contains("768x1024", prompt);
        Assert.Contains("严格宽高比 3:4", prompt);
        Assert.Contains("竖版 / portrait", prompt);
        Assert.Contains("不要输出正方形", prompt);
        Assert.EndsWith("生成商品海报", prompt);
        Assert.False(body.ContainsKey("size"));
        Assert.False(body.ContainsKey("width"));
        Assert.False(body.ContainsKey("height"));
        Assert.False(body.ContainsKey("aspect_ratio"));
    }

    [Fact]
    public void ApplyAdaptiveSizePrompt_IsIdempotent()
    {
        var requestParams = ImageGenModelAdapterRegistry.BuildRequestParams("gpt-image-2-all", "1344x768");
        var config = ImageGenModelAdapterRegistry.TryMatch("gpt-image-2-all");

        var once = ImageGenRequestBuilder.ApplyAdaptiveSizePrompt("生成横版主视觉", requestParams, config);
        var twice = ImageGenRequestBuilder.ApplyAdaptiveSizePrompt(once, requestParams, config);

        Assert.Equal(once, twice);
        Assert.Equal(1, once.Split(
            "[输出尺寸要求 / OUTPUT SIZE，最高优先级]",
            StringSplitOptions.None).Length - 1);
    }

    [Fact]
    public void ApplyAdaptiveSizePrompt_NativeSizeModel_DoesNotChangePrompt()
    {
        var requestParams = ImageGenModelAdapterRegistry.BuildRequestParams("dall-e-3", "1024x1792");
        var config = ImageGenModelAdapterRegistry.TryMatch("dall-e-3");

        var prompt = ImageGenRequestBuilder.ApplyAdaptiveSizePrompt("生成竖版海报", requestParams, config);

        Assert.Equal("生成竖版海报", prompt);
    }

    [Fact]
    public void ApplyAdaptiveSizePrompt_ConfiguredNativeModel_InjectsPromptAndKeepsAspectRatioParam()
    {
        var requestParams = ImageGenModelAdapterRegistry.BuildRequestParams("openai/gpt-image-2", "768x1024");
        var config = ImageGenModelAdapterRegistry.TryMatch("openai/gpt-image-2");

        var prompt = ImageGenRequestBuilder.ApplyAdaptiveSizePrompt("生成竖版海报", requestParams, config);

        Assert.StartsWith("[输出尺寸要求 / OUTPUT SIZE，最高优先级]", prompt);
        Assert.Contains("严格宽高比 3:4", prompt);
        Assert.Equal("3:4", requestParams.SizeParams["aspect_ratio"]);
        Assert.False(requestParams.IsAdaptive);
    }

    [Fact]
    public void ApplyAdaptiveSizePrompt_SizeNotApplicableModel_DoesNotChangePrompt()
    {
        var requestParams = ImageGenModelAdapterRegistry.BuildRequestParams("fal-qwen-image-layered", "768x1024");
        var config = ImageGenModelAdapterRegistry.TryMatch("fal-qwen-image-layered");

        var prompt = ImageGenRequestBuilder.ApplyAdaptiveSizePrompt("分离图片图层", requestParams, config);

        Assert.Equal("分离图片图层", prompt);
    }

    [Fact]
    public void IdentifyActualImageSize_UsesImageBytesInsteadOfRequestedPlaceholder()
    {
        using var image = new Image<Rgba32>(1152, 1536);
        using var stream = new MemoryStream();
        image.SaveAsPng(stream);

        var actualSize = OpenAIImageClient.IdentifyActualImageSize(stream.ToArray());

        Assert.Equal("1152x1536", actualSize);
    }

    [Fact]
    public void UpstreamImageSizeCapabilities_ParseFieldAndPromptWithoutModelNameMatching()
    {
        var state = ImageSizeControlCapabilities.Parse(new Dictionary<string, bool>
        {
            ["image_size.prompt"] = true,
            ["image_size.field.aspect_ratio"] = true,
        });

        Assert.True(state.IsConfigured);
        Assert.True(state.UseField);
        Assert.True(state.UsePrompt);
        Assert.Equal(ImageSizeControlModes.FieldAndPrompt, state.Mode);
        Assert.Equal(ImageSizeFieldFormats.AspectRatio, state.FieldFormat);
    }
}
