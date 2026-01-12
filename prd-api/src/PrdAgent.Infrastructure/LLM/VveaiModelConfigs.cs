namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// vveai 平台模型配置集合
/// 基于 https://api.vveai.com (api-gpt-ge.apifox.cn) 文档
/// </summary>
public static class VveaiModelConfigs
{
    /// <summary>
    /// 所有已知的 vveai 平台模型适配配置
    /// </summary>
    public static readonly List<VveaiModelAdapterConfig> Configs = new()
    {
        // ===== Gemini Nano-Banana 系列 =====
        new VveaiModelAdapterConfig
        {
            ModelIdPattern = "nano-banana*",
            DisplayName = "Gemini Nano-Banana",
            Provider = "Google",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "支持 1K/2K/4K 分辨率档位的固定尺寸",
            AllowedSizes = new List<string>
            {
                // 1K 档位
                "1024x1024", "832x1248", "1248x832", "864x1184", "1184x864",
                "896x1152", "1152x896", "768x1344", "1344x768", "848x1264", "1264x848",
                "928x1152", "1152x928", "768x1376", "1376x768", "1536x672", "1584x672",
                "896x1200", "1200x896",
                // 2K 档位
                "2048x2048", "1696x2528", "2528x1696", "1792x2400", "2400x1792",
                "1856x2304", "2304x1856", "1536x2752", "2752x1536", "3168x1344",
                // 4K 档位
                "4096x4096", "3392x5056", "5056x3392", "3584x4800", "4800x3584",
                "3712x4608", "4608x3712", "3072x5504", "5504x3072", "6336x2688",
            },
            AllowedRatios = new List<string> { "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9" },
            SizeParamFormat = SizeParamFormats.WxH,
            MaxWidth = 6144,
            MaxHeight = 6144,
            MinWidth = 768,
            MinHeight = 672,
            Notes = new List<string> { "支持 1K, 2K, 4K 三个档位", "4K 分辨率可能导致响应超时" },
            SupportsImageToImage = true,
            SupportsInpainting = true,
        },

        // ===== DALL-E 3 =====
        new VveaiModelAdapterConfig
        {
            ModelIdPattern = "dall-e-3",
            DisplayName = "DALL-E 3",
            Provider = "OpenAI",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "仅支持固定尺寸白名单",
            AllowedSizes = new List<string> { "1024x1024", "1024x1792", "1792x1024" },
            AllowedRatios = new List<string> { "1:1", "9:16", "16:9" },
            SizeParamFormat = SizeParamFormats.WxH,
            MaxWidth = 1792,
            MaxHeight = 1792,
            MinWidth = 1024,
            MinHeight = 1024,
            Notes = new List<string> { "DALL-E 3 仅支持 1024x1024, 1024x1792, 1792x1024" },
            SupportsImageToImage = false,
            SupportsInpainting = false,
        },

        // ===== DALL-E 2 =====
        new VveaiModelAdapterConfig
        {
            ModelIdPattern = "dall-e-2",
            DisplayName = "DALL-E 2",
            Provider = "OpenAI",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "仅支持固定尺寸白名单",
            AllowedSizes = new List<string> { "256x256", "512x512", "1024x1024" },
            AllowedRatios = new List<string> { "1:1" },
            SizeParamFormat = SizeParamFormats.WxH,
            MaxWidth = 1024,
            MaxHeight = 1024,
            MinWidth = 256,
            MinHeight = 256,
            Notes = new List<string> { "DALL-E 2 仅支持正方形尺寸" },
            SupportsImageToImage = true,
            SupportsInpainting = true,
        },

        // ===== Flux Pro =====
        new VveaiModelAdapterConfig
        {
            ModelIdPattern = "flux*",
            DisplayName = "Flux Pro",
            Provider = "Black Forest Labs",
            SizeConstraintType = SizeConstraintTypes.Range,
            SizeConstraintDescription = "在指定范围内支持任意尺寸，需为 32 的倍数",
            AllowedSizes = new List<string> { "1024x1024" }, // 默认尺寸
            AllowedRatios = new List<string>(), // 任意比例
            SizeParamFormat = SizeParamFormats.WidthHeight,
            MustBeDivisibleBy = 32,
            MaxWidth = 1440,
            MaxHeight = 1440,
            MinWidth = 256,
            MinHeight = 256,
            MaxPixels = 2073600, // 约 1440x1440
            Notes = new List<string> { "宽高需在 256-1440 之间，且为 32 的倍数" },
            SupportsImageToImage = true,
            SupportsInpainting = false,
        },

        // ===== 即梦 AI 4.0 =====
        new VveaiModelAdapterConfig
        {
            ModelIdPattern = "jimeng*",
            DisplayName = "即梦 AI",
            Provider = "字节跳动",
            SizeConstraintType = SizeConstraintTypes.AspectRatio,
            SizeConstraintDescription = "通过 aspect_ratio 和 resolution 参数控制尺寸",
            AllowedSizes = new List<string>
            {
                "1024x1024", "1024x1792", "1792x1024",
                "2048x2048", "4096x4096"
            },
            AllowedRatios = new List<string> { "1:1", "9:16", "16:9", "3:4", "4:3", "2:3", "3:2" },
            SizeParamFormat = SizeParamFormats.AspectRatio,
            RequiresResolutionParam = true,
            MaxWidth = 4096,
            MaxHeight = 4096,
            MinWidth = 1024,
            MinHeight = 1024,
            Notes = new List<string> { "通过 aspect_ratio 和 resolution 参数控制尺寸" },
            SupportsImageToImage = true,
            SupportsInpainting = true,
        },

        // ===== 通义万相 qwen-image =====
        new VveaiModelAdapterConfig
        {
            ModelIdPattern = "qwen-image*",
            DisplayName = "通义万相 qwen-image",
            Provider = "阿里云",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "qwen-image 支持固定尺寸白名单",
            AllowedSizes = new List<string>
            {
                "1328x1328", "1472x1140", "1140x1472", "1664x928", "928x1664"
            },
            AllowedRatios = new List<string> { "1:1", "4:3", "3:4", "16:9", "9:16" },
            SizeParamFormat = SizeParamFormats.WxH,
            MaxWidth = 1664,
            MaxHeight = 1664,
            MinWidth = 928,
            MinHeight = 928,
            MaxPixels = 2000000,
            Notes = new List<string> { "通义万相(wan2.2)支持范围 [512, 1440]，最高 200 万像素" },
            SupportsImageToImage = false,
            SupportsInpainting = true,
        },

        // ===== Grok-2 Image =====
        new VveaiModelAdapterConfig
        {
            ModelIdPattern = "grok-2-image*",
            DisplayName = "Grok-2 Image",
            Provider = "xAI",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "接口与 DALL-E 基本一致",
            AllowedSizes = new List<string> { "1024x1024" },
            AllowedRatios = new List<string> { "1:1", "9:16", "16:9" },
            SizeParamFormat = SizeParamFormats.WxH,
            MaxWidth = 1792,
            MaxHeight = 1792,
            MinWidth = 1024,
            MinHeight = 1024,
            Notes = new List<string> { "支持参数较 DALL-E 更少" },
            SupportsImageToImage = false,
            SupportsInpainting = false,
        },

        // ===== Stable Diffusion 3.5 =====
        new VveaiModelAdapterConfig
        {
            ModelIdPattern = "stable-diffusion*",
            DisplayName = "Stable Diffusion 3.5",
            Provider = "Stability AI",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "支持固定尺寸枚举值",
            AllowedSizes = new List<string>
            {
                "1024x1024", "1152x896", "896x1152",
                "1024x576", "576x1024", "768x1024", "1024x768",
                "1024x640", "640x1024", "512x512", "256x256"
            },
            AllowedRatios = new List<string> { "1:1", "9:7", "7:9", "16:9", "9:16", "3:4", "4:3", "8:5", "5:8" },
            SizeParamFormat = SizeParamFormats.WxH,
            MaxWidth = 1152,
            MaxHeight = 1152,
            MinWidth = 256,
            MinHeight = 256,
            Notes = new List<string> { "仅支持枚举中的尺寸" },
            SupportsImageToImage = false,
            SupportsInpainting = false,
        },

        // ===== 可灵 AI 1.5 =====
        new VveaiModelAdapterConfig
        {
            ModelIdPattern = "kling*",
            DisplayName = "可灵 AI",
            Provider = "快手",
            SizeConstraintType = SizeConstraintTypes.AspectRatio,
            SizeConstraintDescription = "支持固定比例枚举值",
            AllowedSizes = new List<string>(), // 具体像素由模型决定
            AllowedRatios = new List<string> { "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3" },
            SizeParamFormat = SizeParamFormats.AspectRatio,
            ParamRenames = new Dictionary<string, string> { { "model", "model_name" } },
            Notes = new List<string> { "通过 aspect_ratio 参数控制比例，具体像素由模型决定" },
            SupportsImageToImage = true,
            SupportsInpainting = false,
        },
    };

    /// <summary>
    /// vveai 平台的 API URL 模式
    /// </summary>
    public static readonly List<string> VveaiApiUrlPatterns = new()
    {
        "api.vveai.com",
        "vveai.com",
        "api-gpt-ge.apifox.cn"
    };

    /// <summary>
    /// 检查是否为 vveai 平台
    /// </summary>
    public static bool IsVveaiPlatform(string? apiUrl)
    {
        if (string.IsNullOrWhiteSpace(apiUrl)) return false;
        var url = apiUrl.Trim().ToLowerInvariant();
        return VveaiApiUrlPatterns.Any(pattern => url.Contains(pattern, StringComparison.OrdinalIgnoreCase));
    }
}
