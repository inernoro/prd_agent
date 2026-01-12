namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// vveai 平台模型尺寸约束类型
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
/// vveai 平台模型尺寸参数格式
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
/// vveai 平台模型适配配置
/// </summary>
public class VveaiModelAdapterConfig
{
    /// <summary>模型匹配模式（支持通配符 *，如 nano-banana*）</summary>
    public string ModelIdPattern { get; set; } = string.Empty;

    /// <summary>显示名称（如 Gemini Nano-Banana）</summary>
    public string DisplayName { get; set; } = string.Empty;

    /// <summary>提供商名称（如 Google、OpenAI）</summary>
    public string Provider { get; set; } = string.Empty;

    /// <summary>尺寸约束类型：whitelist / range / aspect_ratio</summary>
    public string SizeConstraintType { get; set; } = SizeConstraintTypes.Whitelist;

    /// <summary>约束描述</summary>
    public string SizeConstraintDescription { get; set; } = string.Empty;

    /// <summary>白名单尺寸列表（格式：WxH）</summary>
    public List<string> AllowedSizes { get; set; } = new();

    /// <summary>允许的比例列表（如 1:1, 2:3）</summary>
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
