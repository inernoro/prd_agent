namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// 生图模型配置集合
/// 基于模型名匹配，适用于所有平台
/// </summary>
public static class ImageGenModelConfigs
{
    /// <summary>
    /// 所有已知的生图模型适配配置
    /// </summary>
    public static readonly List<ImageGenModelAdapterConfig> Configs = new()
    {
        // ===== Gemini Nano-Banana 系列 =====
        new ImageGenModelAdapterConfig
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
        new ImageGenModelAdapterConfig
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
        new ImageGenModelAdapterConfig
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
        new ImageGenModelAdapterConfig
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
        new ImageGenModelAdapterConfig
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
        new ImageGenModelAdapterConfig
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
        new ImageGenModelAdapterConfig
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
        new ImageGenModelAdapterConfig
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
        new ImageGenModelAdapterConfig
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

        // ===== 豆包 Seedream 4.5（火山引擎）=====
        new ImageGenModelAdapterConfig
        {
            ModelIdPattern = "doubao-seedream-4-5*",
            DisplayName = "豆包 Seedream 4.5",
            Provider = "字节跳动 (火山引擎)",
            SizeConstraintType = SizeConstraintTypes.Range,
            SizeConstraintDescription = "支持 2K/4K 档位，总像素 [3,686,400 ~ 16,777,216]",
            AllowedSizes = new List<string>
            {
                // 2K 档位（约 1920x1920 ~ 2048x2048）
                "2048x2048", "2560x1440", "1440x2560", "2304x1728", "1728x2304",
                "2400x1600", "1600x2400", "2176x1920", "1920x2176",
                // 4K 档位
                "4096x4096", "3840x2160", "2160x3840", "4608x3456", "3456x4608",
            },
            AllowedRatios = new List<string> { "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3" },
            SizeParamFormat = SizeParamFormats.WxH,
            MustBeDivisibleBy = 8,
            MinWidth = 14,
            MinHeight = 14,
            MaxWidth = 6000,
            MaxHeight = 6000,
            MaxPixels = 16777216,
            Notes = new List<string> { "总像素下限 3,686,400（约 1920x1920）", "不支持 1K 档位" },
            SupportsImageToImage = true,
            SupportsInpainting = false,
        },

        // ===== 豆包 Seedream 4.0（火山引擎）=====
        new ImageGenModelAdapterConfig
        {
            ModelIdPattern = "doubao-seedream-4-0*",
            DisplayName = "豆包 Seedream 4.0",
            Provider = "字节跳动 (火山引擎)",
            SizeConstraintType = SizeConstraintTypes.Range,
            SizeConstraintDescription = "支持 1K/2K/4K 全档位，总像素 [921,600 ~ 16,777,216]",
            AllowedSizes = new List<string>
            {
                // 1K 档位
                "1024x1024", "1280x720", "720x1280", "1152x864", "864x1152",
                "1200x800", "800x1200",
                // 2K 档位
                "2048x2048", "2560x1440", "1440x2560", "2304x1728", "1728x2304",
                // 4K 档位
                "4096x4096", "3840x2160", "2160x3840",
            },
            AllowedRatios = new List<string> { "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3" },
            SizeParamFormat = SizeParamFormats.WxH,
            MustBeDivisibleBy = 8,
            MinWidth = 14,
            MinHeight = 14,
            MaxWidth = 6000,
            MaxHeight = 6000,
            MaxPixels = 16777216,
            Notes = new List<string> { "支持 1K/2K/4K 全档位" },
            SupportsImageToImage = true,
            SupportsInpainting = false,
        },

        // ===== 豆包 Seedream 3.0（火山引擎）=====
        new ImageGenModelAdapterConfig
        {
            ModelIdPattern = "doubao-seedream-3*",
            DisplayName = "豆包 Seedream 3.0",
            Provider = "字节跳动 (火山引擎)",
            SizeConstraintType = SizeConstraintTypes.Range,
            SizeConstraintDescription = "仅支持约 1K 档位，总像素 [262,144 ~ 4,194,304]",
            AllowedSizes = new List<string>
            {
                "1024x1024", "1280x720", "720x1280", "1152x864", "864x1152",
                "1200x800", "800x1200", "960x960",
            },
            AllowedRatios = new List<string> { "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3" },
            SizeParamFormat = SizeParamFormats.WxH,
            MustBeDivisibleBy = 8,
            MinWidth = 14,
            MinHeight = 14,
            MaxWidth = 2048,
            MaxHeight = 2048,
            MaxPixels = 4194304,
            Notes = new List<string> { "不支持 2K/4K 档位" },
            SupportsImageToImage = true,
            SupportsInpainting = false,
        },
    };
}
