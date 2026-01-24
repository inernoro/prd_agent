using PrdAgent.Infrastructure.LLM;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 图片生成模型适配器测试
/// 覆盖模型匹配、尺寸适配、参数转换等核心功能
/// </summary>
public class ImageGenModelAdapterTests
{
    #region TryMatch 模型匹配测试

    [Theory]
    [InlineData("dall-e-3", "dall-e-3", "DALL-E 3")]
    [InlineData("DALL-E-3", "dall-e-3", "DALL-E 3")] // 大小写不敏感
    [InlineData("dall-e-2", "dall-e-2", "DALL-E 2")]
    [InlineData("flux-pro", "flux*", "Flux Pro")]
    [InlineData("flux-dev-1.2", "flux*", "Flux Pro")]
    [InlineData("nano-banana-v1", "nano-banana*", "Gemini Nano-Banana")]
    [InlineData("nano-banana", "nano-banana*", "Gemini Nano-Banana")]
    [InlineData("jimeng-ai-4.0", "jimeng*", "即梦 AI")]
    [InlineData("qwen-image-gen", "qwen-image*", "通义万相 qwen-image")]
    [InlineData("grok-2-image", "grok-2-image*", "Grok-2 Image")]
    [InlineData("stable-diffusion-3.5", "stable-diffusion*", "Stable Diffusion 3.5")]
    [InlineData("kling-v1.5", "kling*", "可灵 AI")]
    public void TryMatch_KnownModels_ReturnsCorrectConfig(string modelId, string expectedPattern, string expectedDisplayName)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch(modelId);

        Assert.NotNull(config);
        Assert.Equal(expectedPattern, config.ModelIdPattern);
        Assert.Equal(expectedDisplayName, config.DisplayName);
    }

    [Theory]
    [InlineData("doubao-seedream-4-5-251128", "doubao-seedream-4-5*", "豆包 Seedream 4.5")]
    [InlineData("doubao-seedream-4-5", "doubao-seedream-4-5*", "豆包 Seedream 4.5")]
    [InlineData("doubao-seedream-4-0-250828", "doubao-seedream-4-0*", "豆包 Seedream 4.0")]
    [InlineData("doubao-seedream-4-0", "doubao-seedream-4-0*", "豆包 Seedream 4.0")]
    [InlineData("doubao-seedream-3.0", "doubao-seedream-3*", "豆包 Seedream 3.0")]
    [InlineData("doubao-seedream-3", "doubao-seedream-3*", "豆包 Seedream 3.0")]
    public void TryMatch_DoubaoModels_ReturnsCorrectConfig(string modelId, string expectedPattern, string expectedDisplayName)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch(modelId);

        Assert.NotNull(config);
        Assert.Equal(expectedPattern, config.ModelIdPattern);
        Assert.Equal(expectedDisplayName, config.DisplayName);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("unknown-model")]
    [InlineData("gpt-4-turbo")] // 非生图模型
    [InlineData("deepseek-v3")] // 非生图模型
    public void TryMatch_UnknownOrInvalidModels_ReturnsNull(string? modelId)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch(modelId);
        Assert.Null(config);
    }

    #endregion

    #region NormalizeSize 白名单模式测试 (DALL-E 3)

    [Theory]
    [InlineData("1024x1024", "1024x1024", 1024, 1024, false)] // 精确匹配
    [InlineData("1024x1792", "1024x1792", 1024, 1792, false)] // 精确匹配
    [InlineData("1792x1024", "1792x1024", 1792, 1024, false)] // 精确匹配
    [InlineData("1000x1000", "1024x1024", 1024, 1024, true)]  // 接近 1:1，选择 1024x1024
    [InlineData("800x1400", "1024x1792", 1024, 1792, true)]   // 接近 9:16，选择 1024x1792
    [InlineData("1400x800", "1792x1024", 1792, 1024, true)]   // 接近 16:9，选择 1792x1024
    [InlineData("512x512", "1024x1024", 1024, 1024, true)]    // 小尺寸，选择最接近比例
    public void NormalizeSize_DallE3_Whitelist_SelectsClosest(
        string requestedSize, string expectedSize, int expectedW, int expectedH, bool expectedAdjusted)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("dall-e-3");
        Assert.NotNull(config);

        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, requestedSize);

        Assert.Equal(expectedSize, result.Size);
        Assert.Equal(expectedW, result.Width);
        Assert.Equal(expectedH, result.Height);
        Assert.Equal(expectedAdjusted, result.SizeAdjusted);
    }

    [Theory]
    [InlineData("256x256", "256x256", 256, 256, false)]
    [InlineData("512x512", "512x512", 512, 512, false)]
    [InlineData("1024x1024", "1024x1024", 1024, 1024, false)]
    [InlineData("300x300", "256x256", 256, 256, true)]   // 选择最接近的
    [InlineData("700x700", "512x512", 512, 512, true)]   // 选择最接近的
    [InlineData("2048x2048", "1024x1024", 1024, 1024, true)] // 超出范围，选择最大
    public void NormalizeSize_DallE2_OnlySquare(
        string requestedSize, string expectedSize, int expectedW, int expectedH, bool expectedAdjusted)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("dall-e-2");
        Assert.NotNull(config);

        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, requestedSize);

        Assert.Equal(expectedSize, result.Size);
        Assert.Equal(expectedW, result.Width);
        Assert.Equal(expectedH, result.Height);
        Assert.Equal(expectedAdjusted, result.SizeAdjusted);
    }

    #endregion

    #region NormalizeSize 范围模式测试 (Flux, Doubao)

    [Theory]
    [InlineData("1024x1024", 1024, 1024, false)]
    [InlineData("1280x720", 1280, 704, true)]   // 720 不是 32 的倍数，调整为 704
    [InlineData("512x512", 512, 512, false)]    // 在范围内且是 32 的倍数
    [InlineData("256x256", 256, 256, false)]    // 最小值
    [InlineData("1440x1440", 1440, 1440, false)] // 最大值
    [InlineData("200x200", 256, 256, true)]     // 低于最小值，调整到 256
    [InlineData("1500x1500", 1440, 1440, true)] // 超过最大值，调整到 1440
    public void NormalizeSize_Flux_RangeMode_AppliesConstraints(
        string requestedSize, int expectedW, int expectedH, bool expectedAdjusted)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("flux-pro");
        Assert.NotNull(config);
        Assert.Equal(SizeConstraintTypes.Range, config.SizeConstraintType);
        Assert.Equal(32, config.MustBeDivisibleBy);

        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, requestedSize);

        Assert.Equal(expectedW, result.Width);
        Assert.Equal(expectedH, result.Height);
        Assert.Equal(expectedAdjusted, result.SizeAdjusted);
        // 验证整除性
        Assert.Equal(0, result.Width % 32);
        Assert.Equal(0, result.Height % 32);
    }

    [Theory]
    [InlineData("2048x2048", 2048, 2048)]  // 2K 档位标准
    [InlineData("2560x1440", 2560, 1440)]  // 2K 档位 16:9
    [InlineData("4096x4096", 4096, 4096)]  // 4K 档位标准
    [InlineData("3840x2160", 3840, 2160)]  // 4K 档位 16:9
    [InlineData("1024x1024", 1024, 1024)]  // 1K 档位 - Seedream 4.5 支持范围模式
    public void NormalizeSize_DoubaoSeedream45_RangeMode(
        string requestedSize, int expectedW, int expectedH)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("doubao-seedream-4-5-251128");
        Assert.NotNull(config);
        Assert.Equal(SizeConstraintTypes.Range, config.SizeConstraintType);
        Assert.Equal("豆包 Seedream 4.5", config.DisplayName);
        Assert.Equal(8, config.MustBeDivisibleBy);

        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, requestedSize);

        Assert.Equal(expectedW, result.Width);
        Assert.Equal(expectedH, result.Height);
        // 验证整除性
        Assert.Equal(0, result.Width % 8);
        Assert.Equal(0, result.Height % 8);
    }

    [Theory]
    [InlineData("1024x1024", 1024, 1024)]  // 1K 档位标准
    [InlineData("2048x2048", 2048, 2048)]  // 2K 档位标准
    [InlineData("4096x4096", 4096, 4096)]  // 4K 档位标准
    [InlineData("1280x720", 1280, 720)]    // 1K 档位 16:9
    public void NormalizeSize_DoubaoSeedream40_SupportsAll(
        string requestedSize, int expectedW, int expectedH)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("doubao-seedream-4-0");
        Assert.NotNull(config);
        Assert.Equal("豆包 Seedream 4.0", config.DisplayName);

        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, requestedSize);

        Assert.Equal(expectedW, result.Width);
        Assert.Equal(expectedH, result.Height);
        Assert.Equal(0, result.Width % 8);
        Assert.Equal(0, result.Height % 8);
    }

    [Theory]
    [InlineData("1024x1024")]  // 1K 档位
    [InlineData("960x960")]    // 1K 档位
    [InlineData("2048x2048")]  // 会被缩放到约 2048x2048（刚好在边界）
    public void NormalizeSize_DoubaoSeedream3_Only1K(string requestedSize)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("doubao-seedream-3.0");
        Assert.NotNull(config);
        Assert.Equal("豆包 Seedream 3.0", config.DisplayName);
        Assert.Equal(4194304, config.MaxPixels); // 约 2048x2048

        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, requestedSize);

        // 验证像素总量不超过限制
        Assert.True((long)result.Width * result.Height <= config.MaxPixels);
        Assert.Equal(0, result.Width % 8);
        Assert.Equal(0, result.Height % 8);
    }

    #endregion

    #region NormalizeSize 比例模式测试 (即梦 AI, 可灵 AI)

    [Theory]
    [InlineData("1024x1024", "1:1")]
    [InlineData("1920x1080", "16:9")]
    [InlineData("1080x1920", "9:16")]
    [InlineData("1200x900", "4:3")]
    [InlineData("900x1200", "3:4")]
    public void NormalizeSize_JimengAI_AspectRatioMode_DetectsRatio(
        string requestedSize, string expectedRatio)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("jimeng-ai-4.0");
        Assert.NotNull(config);
        Assert.Equal(SizeConstraintTypes.AspectRatio, config.SizeConstraintType);

        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, requestedSize);

        Assert.Equal(expectedRatio, result.AspectRatio);
    }

    [Theory]
    [InlineData("1024x1024", "1:1")]
    [InlineData("1920x1080", "16:9")]
    [InlineData("1080x1920", "9:16")]
    public void NormalizeSize_KlingAI_AspectRatioMode(
        string requestedSize, string expectedRatio)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("kling-v1.5");
        Assert.NotNull(config);
        Assert.Equal(SizeConstraintTypes.AspectRatio, config.SizeConstraintType);

        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, requestedSize);

        Assert.Equal(expectedRatio, result.AspectRatio);
    }

    #endregion

    #region NormalizeSize 无效输入测试

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("invalid")]
    [InlineData("abc x def")]
    [InlineData("1024")]
    public void NormalizeSize_InvalidSize_ReturnsDefault(string? invalidSize)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("dall-e-3");
        Assert.NotNull(config);

        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, invalidSize);

        // 应该返回默认尺寸
        Assert.True(result.SizeAdjusted);
        Assert.True(result.Width > 0);
        Assert.True(result.Height > 0);
    }

    [Theory]
    [InlineData("1024x1024")]
    [InlineData("1024X1024")]
    [InlineData("1024*1024")]
    [InlineData(" 1024 x 1024 ")]
    public void NormalizeSize_DifferentSizeFormats_Parsed(string size)
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("dall-e-3");
        Assert.NotNull(config);

        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, size);

        Assert.Equal(1024, result.Width);
        Assert.Equal(1024, result.Height);
    }

    #endregion

    #region GetAdapterInfo 测试

    [Theory]
    [InlineData("dall-e-3", true, "DALL-E 3", "OpenAI")]
    [InlineData("flux-pro", true, "Flux Pro", "Black Forest Labs")]
    [InlineData("doubao-seedream-4-5", true, "豆包 Seedream 4.5", "字节跳动 (火山引擎)")]
    [InlineData("doubao-seedream-4-0", true, "豆包 Seedream 4.0", "字节跳动 (火山引擎)")]
    [InlineData("doubao-seedream-3", true, "豆包 Seedream 3.0", "字节跳动 (火山引擎)")]
    [InlineData("jimeng-ai", true, "即梦 AI", "字节跳动")]
    [InlineData("kling-v1", true, "可灵 AI", "快手")]
    [InlineData("qwen-image-v1", true, "通义万相 qwen-image", "阿里云")]
    [InlineData("unknown-model", false, null, null)]
    public void GetAdapterInfo_ReturnsCorrectInfo(
        string modelId, bool expectedMatched, string? expectedDisplayName, string? expectedProvider)
    {
        var info = ImageGenModelAdapterRegistry.GetAdapterInfo(modelId);

        if (expectedMatched)
        {
            Assert.NotNull(info);
            Assert.True(info.Matched);
            Assert.Equal(expectedDisplayName, info.DisplayName);
            Assert.Equal(expectedProvider, info.Provider);
        }
        else
        {
            Assert.Null(info);
        }
    }

    [Fact]
    public void GetAdapterInfo_DallE3_HasCorrectConstraints()
    {
        var info = ImageGenModelAdapterRegistry.GetAdapterInfo("dall-e-3");

        Assert.NotNull(info);
        Assert.Equal(SizeConstraintTypes.Whitelist, info.SizeConstraintType);
        Assert.Equal(SizeParamFormats.WxH, info.SizeParamFormat);
        Assert.Contains("1024x1024", info.AllowedSizes);
        Assert.Contains("1024x1792", info.AllowedSizes);
        Assert.Contains("1792x1024", info.AllowedSizes);
        Assert.Equal(3, info.AllowedSizes.Count);
        Assert.False(info.SupportsImageToImage);
    }

    [Fact]
    public void GetAdapterInfo_Flux_HasCorrectConstraints()
    {
        var info = ImageGenModelAdapterRegistry.GetAdapterInfo("flux-pro");

        Assert.NotNull(info);
        Assert.Equal(SizeConstraintTypes.Range, info.SizeConstraintType);
        Assert.Equal(SizeParamFormats.WidthHeight, info.SizeParamFormat);
        Assert.Equal(32, info.MustBeDivisibleBy);
        Assert.Equal(256, info.MinWidth);
        Assert.Equal(1440, info.MaxWidth);
        Assert.True(info.SupportsImageToImage);
    }

    [Fact]
    public void GetAdapterInfo_DoubaoSeedream45_HasCorrectConstraints()
    {
        var info = ImageGenModelAdapterRegistry.GetAdapterInfo("doubao-seedream-4-5-251128");

        Assert.NotNull(info);
        Assert.Equal(SizeConstraintTypes.Range, info.SizeConstraintType);
        Assert.Equal(SizeParamFormats.WxH, info.SizeParamFormat);
        Assert.Equal(8, info.MustBeDivisibleBy);
        Assert.Equal(16777216, info.MaxPixels);
        Assert.Contains("不支持 1K 档位", info.Notes);
        Assert.True(info.SupportsImageToImage);
    }

    #endregion

    #region ApplySizeParams 测试

    [Fact]
    public void ApplySizeParams_WxH_SetsSizeParam()
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("dall-e-3");
        Assert.NotNull(config);

        var sizeResult = new SizeAdaptationResult
        {
            Size = "1024x1024",
            Width = 1024,
            Height = 1024,
        };
        var targetParams = new Dictionary<string, object>();

        ImageGenModelAdapterRegistry.ApplySizeParams(config, sizeResult, targetParams);

        Assert.True(targetParams.ContainsKey("size"));
        Assert.Equal("1024x1024", targetParams["size"]);
    }

    [Fact]
    public void ApplySizeParams_WidthHeight_SetsWidthAndHeight()
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("flux-pro");
        Assert.NotNull(config);

        var sizeResult = new SizeAdaptationResult
        {
            Size = "1024x768",
            Width = 1024,
            Height = 768,
        };
        var targetParams = new Dictionary<string, object>();

        ImageGenModelAdapterRegistry.ApplySizeParams(config, sizeResult, targetParams);

        Assert.True(targetParams.ContainsKey("width"));
        Assert.True(targetParams.ContainsKey("height"));
        Assert.Equal(1024, targetParams["width"]);
        Assert.Equal(768, targetParams["height"]);
        Assert.False(targetParams.ContainsKey("size"));
    }

    [Fact]
    public void ApplySizeParams_AspectRatio_SetsAspectRatio()
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("jimeng-ai-4.0");
        Assert.NotNull(config);

        var sizeResult = new SizeAdaptationResult
        {
            AspectRatio = "16:9",
            Resolution = "2k",
        };
        var targetParams = new Dictionary<string, object>();

        ImageGenModelAdapterRegistry.ApplySizeParams(config, sizeResult, targetParams);

        Assert.True(targetParams.ContainsKey("aspect_ratio"));
        Assert.Equal("16:9", targetParams["aspect_ratio"]);
        Assert.True(targetParams.ContainsKey("resolution")); // 即梦 AI 需要 resolution 参数
    }

    #endregion

    #region TransformParams 测试

    [Fact]
    public void TransformParams_KlingAI_RenamesModelParam()
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("kling-v1.5");
        Assert.NotNull(config);
        Assert.True(config.ParamRenames.ContainsKey("model"));

        var originalParams = new Dictionary<string, object>
        {
            { "model", "kling-v1.5" },
            { "prompt", "test prompt" },
        };

        var transformed = ImageGenModelAdapterRegistry.TransformParams(config, originalParams);

        Assert.False(transformed.ContainsKey("model"));
        Assert.True(transformed.ContainsKey("model_name"));
        Assert.Equal("kling-v1.5", transformed["model_name"]);
        Assert.Equal("test prompt", transformed["prompt"]);
    }

    [Fact]
    public void TransformParams_NoRenames_ReturnsOriginal()
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("dall-e-3");
        Assert.NotNull(config);
        Assert.Empty(config.ParamRenames);

        var originalParams = new Dictionary<string, object>
        {
            { "model", "dall-e-3" },
            { "prompt", "test prompt" },
        };

        var transformed = ImageGenModelAdapterRegistry.TransformParams(config, originalParams);

        Assert.Equal(originalParams["model"], transformed["model"]);
        Assert.Equal(originalParams["prompt"], transformed["prompt"]);
    }

    #endregion

    #region 跨平台同名模型测试

    [Fact]
    public void TryMatch_SameModelDifferentVersions_MatchesCorrectly()
    {
        // 测试豆包系列不同版本的正确匹配
        var config45 = ImageGenModelAdapterRegistry.TryMatch("doubao-seedream-4-5-251128");
        var config40 = ImageGenModelAdapterRegistry.TryMatch("doubao-seedream-4-0-lite");
        var config30 = ImageGenModelAdapterRegistry.TryMatch("doubao-seedream-3.0");

        Assert.NotNull(config45);
        Assert.NotNull(config40);
        Assert.NotNull(config30);

        // 确保匹配到不同的配置
        Assert.Equal("doubao-seedream-4-5*", config45.ModelIdPattern);
        Assert.Equal("doubao-seedream-4-0*", config40.ModelIdPattern);
        Assert.Equal("doubao-seedream-3*", config30.ModelIdPattern);

        // 验证各自的特性
        Assert.Contains("不支持 1K 档位", config45.Notes);
        Assert.Contains("支持 1K/2K/4K 全档位", config40.Notes);
        Assert.Contains("不支持 2K/4K 档位", config30.Notes);
    }

    [Fact]
    public void NormalizeSize_CrossPlatformComparison_DifferentBehaviors()
    {
        // 同样的请求尺寸，不同模型应有不同的处理结果
        var requestedSize = "1024x1024";

        // DALL-E 3 白名单模式：精确匹配
        var dallE3 = ImageGenModelAdapterRegistry.TryMatch("dall-e-3");
        var dallE3Result = ImageGenModelAdapterRegistry.NormalizeSize(dallE3!, requestedSize);
        Assert.Equal("1024x1024", dallE3Result.Size);

        // Flux 范围模式：可能调整为 32 的倍数
        var flux = ImageGenModelAdapterRegistry.TryMatch("flux-pro");
        var fluxResult = ImageGenModelAdapterRegistry.NormalizeSize(flux!, requestedSize);
        Assert.Equal(0, fluxResult.Width % 32);

        // 豆包 Seedream 4.5：可能不支持 1K
        var doubao45 = ImageGenModelAdapterRegistry.TryMatch("doubao-seedream-4-5");
        var doubao45Result = ImageGenModelAdapterRegistry.NormalizeSize(doubao45!, requestedSize);
        Assert.Equal(0, doubao45Result.Width % 8);
    }

    #endregion

    #region Resolution 档位检测测试

    [Theory]
    [InlineData(1024, 1024, "1k")]       // 标准 1K
    [InlineData(1248, 832, "1k")]        // nano-banana 1K 档位白名单
    [InlineData(2048, 2048, "2k")]       // 标准 2K
    [InlineData(2528, 1696, "2k")]       // nano-banana 2K 档位白名单
    [InlineData(4096, 4096, "4k")]       // 标准 4K
    [InlineData(5056, 3392, "4k")]       // nano-banana 4K 档位白名单
    public void NormalizeSize_DetectsCorrectResolutionTier(int width, int height, string expectedTier)
    {
        // 使用 nano-banana 模型，它支持 1K/2K/4K 三个档位
        var config = ImageGenModelAdapterRegistry.TryMatch("nano-banana");
        Assert.NotNull(config);

        var requestedSize = $"{width}x{height}";
        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, requestedSize);

        // 检测实际返回的分辨率档位
        Assert.Equal(expectedTier, result.Resolution);
    }

    [Theory]
    [InlineData("1024x1024", "1k")]
    [InlineData("2048x2048", "2k")]
    [InlineData("4096x4096", "4k")]
    public void NormalizeSize_ResolutionTier_BasicSizes(string requestedSize, string expectedTier)
    {
        // 使用 doubao-seedream-4-0，它支持 1K/2K/4K 全档位
        var config = ImageGenModelAdapterRegistry.TryMatch("doubao-seedream-4-0");
        Assert.NotNull(config);
        Assert.Equal(SizeConstraintTypes.Range, config.SizeConstraintType);

        var result = ImageGenModelAdapterRegistry.NormalizeSize(config, requestedSize);

        Assert.Equal(expectedTier, result.Resolution);
    }

    #endregion
}
