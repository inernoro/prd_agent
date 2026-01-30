namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// 生图尺寸选项（用于前端展示，按分辨率分组）
/// </summary>
public class SizeOption
{
    public string Size { get; set; } = string.Empty;
    public string AspectRatio { get; set; } = string.Empty;

    public SizeOption() { }
    public SizeOption(string size, string aspectRatio)
    {
        Size = size;
        AspectRatio = aspectRatio;
    }
}

/// <summary>
/// 生图模型尺寸约束类型
/// </summary>
public static class SizeConstraintTypes
{
    /// <summary>仅支持固定尺寸白名单</summary>
    public const string Whitelist = "whitelist";
    /// <summary>支持范围内任意尺寸</summary>
    public const string Range = "range";
    /// <summary>仅支持比例枚举（具体像素由模型决定）</summary>
    public const string AspectRatio = "aspect_ratio";
}

/// <summary>
/// 生图模型尺寸参数格式
/// </summary>
public static class SizeParamFormats
{
    /// <summary>WxH 格式（如 1024x1024）</summary>
    public const string WxH = "WxH";
    /// <summary>{width, height} 对象格式</summary>
    public const string WidthHeight = "{width,height}";
    /// <summary>aspect_ratio 比例格式（如 1:1）</summary>
    public const string AspectRatio = "aspect_ratio";
}

/// <summary>
/// 生图模型适配配置
/// </summary>
public class ImageGenModelAdapterConfig
{
    /// <summary>模型匹配模式（支持通配符 *，如 nano-banana*）</summary>
    public string ModelIdPattern { get; set; } = string.Empty;

    /// <summary>显示名称（如 Gemini Nano-Banana）</summary>
    public string DisplayName { get; set; } = string.Empty;

    /// <summary>提供商名称（如 Google、OpenAI）</summary>
    public string Provider { get; set; } = string.Empty;

    /// <summary>
    /// 平台类型标识（用于选择正确的平台适配器）
    /// 值：openai / volces / null（自动检测）
    /// </summary>
    public string? PlatformType { get; set; }

    /// <summary>官方文档链接（方便对照校验）</summary>
    public string? OfficialDocUrl { get; set; }

    /// <summary>配置最后更新时间（如 2026-01-29）</summary>
    public string? LastUpdated { get; set; }

    /// <summary>尺寸约束类型：whitelist / range / aspect_ratio</summary>
    public string SizeConstraintType { get; set; } = SizeConstraintTypes.Whitelist;

    /// <summary>约束描述</summary>
    public string SizeConstraintDescription { get; set; } = string.Empty;

    /// <summary>
    /// 按分辨率分组的尺寸选项（1k/2k/4k）
    /// 前端直接使用，无需转换
    /// </summary>
    public Dictionary<string, List<SizeOption>> SizesByResolution { get; set; } = new()
    {
        ["1k"] = new(),
        ["2k"] = new(),
        ["4k"] = new(),
    };

    /// <summary>白名单尺寸列表（格式：WxH）- 已废弃，请使用 SizesByResolution</summary>
    [Obsolete("请使用 SizesByResolution 代替")]
    public List<string> AllowedSizes { get; set; } = new();

    /// <summary>允许的比例列表（如 1:1, 2:3）- 已废弃，比例信息已包含在 SizesByResolution 中</summary>
    [Obsolete("比例信息已包含在 SizesByResolution 中")]
    public List<string> AllowedRatios { get; set; } = new();

    /// <summary>尺寸参数格式：WxH / {width,height} / aspect_ratio</summary>
    public string SizeParamFormat { get; set; } = SizeParamFormats.WxH;

    /// <summary>宽高必须整除的值（如 32、64）</summary>
    public int? MustBeDivisibleBy { get; set; }

    /// <summary>最大宽度</summary>
    public int? MaxWidth { get; set; }

    /// <summary>最大高度</summary>
    public int? MaxHeight { get; set; }

    /// <summary>最小宽度</summary>
    public int? MinWidth { get; set; }

    /// <summary>最小高度</summary>
    public int? MinHeight { get; set; }

    /// <summary>最大像素总量</summary>
    public long? MaxPixels { get; set; }

    /// <summary>参数重命名映射（如 model -> model_name）</summary>
    public Dictionary<string, string> ParamRenames { get; set; } = new();

    /// <summary>是否需要 resolution 参数（如即梦的 1k/2k/4k）</summary>
    public bool RequiresResolutionParam { get; set; } = false;

    /// <summary>备注说明</summary>
    public List<string> Notes { get; set; } = new();

    /// <summary>是否支持图生图</summary>
    public bool SupportsImageToImage { get; set; } = false;

    /// <summary>是否支持局部重绘</summary>
    public bool SupportsInpainting { get; set; } = false;
}

/// <summary>
/// 尺寸适配结果
/// </summary>
public class SizeAdaptationResult
{
    /// <summary>适配后的尺寸（WxH 格式）</summary>
    public string Size { get; set; } = string.Empty;

    /// <summary>适配后的宽度</summary>
    public int Width { get; set; }

    /// <summary>适配后的高度</summary>
    public int Height { get; set; }

    /// <summary>适配后的比例（如 1:1）</summary>
    public string? AspectRatio { get; set; }

    /// <summary>分辨率档位（如 1k/2k/4k）</summary>
    public string? Resolution { get; set; }

    /// <summary>是否进行了尺寸调整</summary>
    public bool SizeAdjusted { get; set; }

    /// <summary>是否进行了比例调整</summary>
    public bool RatioAdjusted { get; set; }
}

/// <summary>
/// 一站式生图请求参数构建结果
/// 整合尺寸适配、参数格式转换、参数重命名
/// </summary>
public class ImageGenRequestParams
{
    /// <summary>尺寸适配结果（含元信息：SizeAdjusted, RatioAdjusted, Resolution 等）</summary>
    public SizeAdaptationResult Adaptation { get; set; } = new();

    /// <summary>
    /// 尺寸相关的 API 参数（根据模型格式自动选择）：
    /// - WxH 格式: { "size": "1024x1024" }
    /// - WidthHeight 格式: { "width": 1024, "height": 1024 }
    /// - AspectRatio 格式: { "aspect_ratio": "1:1", "resolution": "2k" }
    /// </summary>
    public Dictionary<string, object> SizeParams { get; set; } = new();

    /// <summary>其他参数（已应用 ParamRenames 重命名，如 model -> model_name）</summary>
    public Dictionary<string, object> OtherParams { get; set; } = new();

    /// <summary>是否匹配到适配器配置</summary>
    public bool HasAdapter { get; set; }

    /// <summary>匹配到的适配器名称（如 doubao-seedream-4-5*）</summary>
    public string? AdapterName { get; set; }

    /// <summary>参数格式类型（WxH / {width,height} / aspect_ratio）</summary>
    public string SizeParamFormat { get; set; } = SizeParamFormats.WxH;
}
