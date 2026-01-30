namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// 生图模型配置集合
/// 基于模型名匹配，适用于所有平台
/// 
/// 配置说明：
/// - SizesByResolution: 按分辨率分组的尺寸配置，前端直接使用，无需转换
/// - 1k: 约 100 万像素（如 1024x1024）
/// - 2k: 约 400 万像素（如 2048x2048）
/// - 4k: 约 1600 万像素（如 4096x4096）
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
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "支持 1K/2K/4K 分辨率档位的固定尺寸",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new()
                {
                    new("1024x1024", "1:1"),
                    new("832x1248", "2:3"),
                    new("1248x832", "3:2"),
                    new("864x1184", "3:4"),
                    new("1184x864", "4:3"),
                    new("896x1152", "4:5"),
                    new("1152x896", "5:4"),
                    new("768x1344", "9:16"),
                    new("1344x768", "16:9"),
                    new("1536x672", "21:9"),
                },
                ["2k"] = new()
                {
                    new("2048x2048", "1:1"),
                    new("1696x2528", "2:3"),
                    new("2528x1696", "3:2"),
                    new("1792x2400", "3:4"),
                    new("2400x1792", "4:3"),
                    new("1856x2304", "4:5"),
                    new("2304x1856", "5:4"),
                    new("1536x2752", "9:16"),
                    new("2752x1536", "16:9"),
                    new("3168x1344", "21:9"),
                },
                ["4k"] = new()
                {
                    new("4096x4096", "1:1"),
                    new("3392x5056", "2:3"),
                    new("5056x3392", "3:2"),
                    new("3584x4800", "3:4"),
                    new("4800x3584", "4:3"),
                    new("3712x4608", "4:5"),
                    new("4608x3712", "5:4"),
                    new("3072x5504", "9:16"),
                    new("5504x3072", "16:9"),
                    new("6336x2688", "21:9"),
                },
            },
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
            OfficialDocUrl = "https://platform.openai.com/docs/guides/images",
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "仅支持固定尺寸白名单",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new()
                {
                    new("1024x1024", "1:1"),
                    new("1024x1792", "9:16"),
                    new("1792x1024", "16:9"),
                },
                ["2k"] = new(),
                ["4k"] = new(),
            },
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
            OfficialDocUrl = "https://platform.openai.com/docs/guides/images",
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "仅支持固定尺寸白名单",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new()
                {
                    new("1024x1024", "1:1"),
                    new("512x512", "1:1"),
                    new("256x256", "1:1"),
                },
                ["2k"] = new(),
                ["4k"] = new(),
            },
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
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.Range,
            SizeConstraintDescription = "在指定范围内支持任意尺寸，需为 32 的倍数",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new()
                {
                    new("1024x1024", "1:1"),
                    new("1024x768", "4:3"),
                    new("768x1024", "3:4"),
                    new("1280x720", "16:9"),
                    new("720x1280", "9:16"),
                },
                ["2k"] = new(),
                ["4k"] = new(),
            },
            SizeParamFormat = SizeParamFormats.WidthHeight,
            MustBeDivisibleBy = 32,
            MaxWidth = 1440,
            MaxHeight = 1440,
            MinWidth = 256,
            MinHeight = 256,
            MaxPixels = 2073600,
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
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.AspectRatio,
            SizeConstraintDescription = "通过 aspect_ratio 和 resolution 参数控制尺寸",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new()
                {
                    new("1024x1024", "1:1"),
                    new("1024x1792", "9:16"),
                    new("1792x1024", "16:9"),
                    new("1024x1360", "3:4"),
                    new("1360x1024", "4:3"),
                },
                ["2k"] = new()
                {
                    new("2048x2048", "1:1"),
                },
                ["4k"] = new()
                {
                    new("4096x4096", "1:1"),
                },
            },
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
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "qwen-image 支持固定尺寸白名单",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new()
                {
                    new("1328x1328", "1:1"),
                    new("1472x1140", "4:3"),
                    new("1140x1472", "3:4"),
                    new("1664x928", "16:9"),
                    new("928x1664", "9:16"),
                },
                ["2k"] = new(),
                ["4k"] = new(),
            },
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
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "接口与 DALL-E 基本一致",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new()
                {
                    new("1024x1024", "1:1"),
                },
                ["2k"] = new(),
                ["4k"] = new(),
            },
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
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.Whitelist,
            SizeConstraintDescription = "支持固定尺寸枚举值",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new()
                {
                    new("1024x1024", "1:1"),
                    new("1152x896", "9:7"),
                    new("896x1152", "7:9"),
                    new("1024x576", "16:9"),
                    new("576x1024", "9:16"),
                    new("1024x768", "4:3"),
                    new("768x1024", "3:4"),
                    new("1024x640", "8:5"),
                    new("640x1024", "5:8"),
                    new("512x512", "1:1"),
                    new("256x256", "1:1"),
                },
                ["2k"] = new(),
                ["4k"] = new(),
            },
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
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.AspectRatio,
            SizeConstraintDescription = "支持固定比例枚举值，具体像素由模型决定",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new()
                {
                    new("1024x1024", "1:1"),
                    new("1280x720", "16:9"),
                    new("720x1280", "9:16"),
                    new("1024x768", "4:3"),
                    new("768x1024", "3:4"),
                    new("1080x720", "3:2"),
                    new("720x1080", "2:3"),
                },
                ["2k"] = new(),
                ["4k"] = new(),
            },
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
            PlatformType = "volces",
            OfficialDocUrl = "https://www.volcengine.com/docs/6791/1361006",
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.Range,
            SizeConstraintDescription = "支持 2K/4K 档位，总像素 [3,686,400 ~ 16,777,216]",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new(), // 不支持 1K
                ["2k"] = new()
                {
                    new("2048x2048", "1:1"),
                    new("2560x1440", "16:9"),
                    new("1440x2560", "9:16"),
                    new("2304x1728", "4:3"),
                    new("1728x2304", "3:4"),
                    new("2400x1600", "3:2"),
                    new("1600x2400", "2:3"),
                },
                ["4k"] = new()
                {
                    new("4096x4096", "1:1"),
                    new("3840x2160", "16:9"),
                    new("2160x3840", "9:16"),
                    new("4608x3456", "4:3"),
                    new("3456x4608", "3:4"),
                },
            },
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
            PlatformType = "volces",
            OfficialDocUrl = "https://www.volcengine.com/docs/6791/1361006",
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.Range,
            SizeConstraintDescription = "支持 1K/2K/4K 全档位，总像素 [921,600 ~ 16,777,216]",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new()
                {
                    new("1024x1024", "1:1"),
                    new("1280x720", "16:9"),
                    new("720x1280", "9:16"),
                    new("1152x864", "4:3"),
                    new("864x1152", "3:4"),
                    new("1200x800", "3:2"),
                    new("800x1200", "2:3"),
                },
                ["2k"] = new()
                {
                    new("2048x2048", "1:1"),
                    new("2560x1440", "16:9"),
                    new("1440x2560", "9:16"),
                    new("2304x1728", "4:3"),
                    new("1728x2304", "3:4"),
                },
                ["4k"] = new()
                {
                    new("4096x4096", "1:1"),
                    new("3840x2160", "16:9"),
                    new("2160x3840", "9:16"),
                },
            },
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
            PlatformType = "volces",
            OfficialDocUrl = "https://www.volcengine.com/docs/6791/1361006",
            LastUpdated = "2026-01-29",
            SizeConstraintType = SizeConstraintTypes.Range,
            SizeConstraintDescription = "仅支持约 1K 档位，总像素 [262,144 ~ 4,194,304]",
            SizesByResolution = new Dictionary<string, List<SizeOption>>
            {
                ["1k"] = new()
                {
                    new("1024x1024", "1:1"),
                    new("1280x720", "16:9"),
                    new("720x1280", "9:16"),
                    new("1152x864", "4:3"),
                    new("864x1152", "3:4"),
                    new("1200x800", "3:2"),
                    new("800x1200", "2:3"),
                    new("960x960", "1:1"),
                },
                ["2k"] = new(), // 不支持 2K
                ["4k"] = new(), // 不支持 4K
            },
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
