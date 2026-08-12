namespace PrdAgent.Core.Models;

/// <summary>
/// 上游生图模型的尺寸控制方式。该能力跟随实际模型配置，不跟随 MAP 业务模型别名。
/// </summary>
public static class ImageSizeControlModes
{
    public const string Inherit = "inherit";
    public const string Field = "field";
    public const string Prompt = "prompt";
    public const string FieldAndPrompt = "field_and_prompt";
    public const string None = "none";
}

/// <summary>上游尺寸字段形状。</summary>
public static class ImageSizeFieldFormats
{
    public const string Size = "size";
    public const string WidthHeight = "width_height";
    public const string AspectRatio = "aspect_ratio";
    public const string ImageConfigAspectRatio = "image_config.aspect_ratio";
}

/// <summary>从模型能力列表解析出的尺寸控制快照。</summary>
public sealed class ImageSizeControlCapabilityState
{
    public string Mode { get; init; } = ImageSizeControlModes.Inherit;
    public string? FieldFormat { get; init; }
    public bool IsConfigured => Mode != ImageSizeControlModes.Inherit;
    public bool UsePrompt => Mode is ImageSizeControlModes.Prompt or ImageSizeControlModes.FieldAndPrompt;
    public bool UseField => Mode is ImageSizeControlModes.Field or ImageSizeControlModes.FieldAndPrompt;
    public bool SizesNotApplicable => Mode == ImageSizeControlModes.None;
}

/// <summary>参数能力类型的有限前缀兼容规则。</summary>
public static class ParameterCapabilityTypes
{
    private static readonly string[] Prefixes = ["parameter:", "parameter.", "param:", "param."];

    public static string? GetParameterName(string? type)
    {
        if (string.IsNullOrWhiteSpace(type)) return null;
        var normalized = type.Trim();
        foreach (var prefix in Prefixes)
        {
            if (!normalized.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
            var name = normalized[prefix.Length..].Trim();
            return name.Length == 0 ? null : name;
        }
        return null;
    }
}

/// <summary>
/// 尺寸控制能力编码。沿用既有 parameter:* 能力矩阵，避免再造一份与模型配置漂移的旁路表。
/// </summary>
public static class ImageSizeControlCapabilities
{
    public const string PromptType = "parameter:image_size.prompt";
    public const string NoneType = "parameter:image_size.none";
    public const string SizeFieldType = "parameter:image_size.field.size";
    public const string WidthHeightFieldType = "parameter:image_size.field.width_height";
    public const string AspectRatioFieldType = "parameter:image_size.field.aspect_ratio";
    public const string ImageConfigAspectRatioFieldType = "parameter:image_size.field.image_config_aspect_ratio";

    private const string ParameterPrefix = "image_size.";

    public static readonly IReadOnlySet<string> SupportedModes = new HashSet<string>(StringComparer.Ordinal)
    {
        ImageSizeControlModes.Inherit,
        ImageSizeControlModes.Field,
        ImageSizeControlModes.Prompt,
        ImageSizeControlModes.FieldAndPrompt,
        ImageSizeControlModes.None,
    };

    public static readonly IReadOnlySet<string> SupportedFieldFormats = new HashSet<string>(StringComparer.Ordinal)
    {
        ImageSizeFieldFormats.Size,
        ImageSizeFieldFormats.WidthHeight,
        ImageSizeFieldFormats.AspectRatio,
        ImageSizeFieldFormats.ImageConfigAspectRatio,
    };

    public static bool IsSizeControlCapability(string? type)
        => ParameterCapabilityTypes.GetParameterName(type)?
            .StartsWith(ParameterPrefix, StringComparison.OrdinalIgnoreCase) == true;

    public static IReadOnlyList<string> BuildCapabilityTypes(string mode, string? fieldFormat)
    {
        var result = new List<string>();
        if (mode == ImageSizeControlModes.None)
        {
            result.Add(NoneType);
            return result;
        }
        if (mode is ImageSizeControlModes.Prompt or ImageSizeControlModes.FieldAndPrompt)
            result.Add(PromptType);
        if (mode is ImageSizeControlModes.Field or ImageSizeControlModes.FieldAndPrompt)
        {
            result.Add(fieldFormat switch
            {
                ImageSizeFieldFormats.Size => SizeFieldType,
                ImageSizeFieldFormats.WidthHeight => WidthHeightFieldType,
                ImageSizeFieldFormats.AspectRatio => AspectRatioFieldType,
                ImageSizeFieldFormats.ImageConfigAspectRatio => ImageConfigAspectRatioFieldType,
                _ => throw new ArgumentOutOfRangeException(nameof(fieldFormat), fieldFormat, "不支持的生图尺寸字段格式"),
            });
        }
        return result;
    }

    public static ImageSizeControlCapabilityState Parse(IEnumerable<LLMModelCapability>? capabilities)
    {
        if (capabilities is null) return new ImageSizeControlCapabilityState();
        var parameters = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        foreach (var capability in capabilities)
        {
            var parameterName = ParameterCapabilityTypes.GetParameterName(capability.Type);
            if (parameterName?.StartsWith(ParameterPrefix, StringComparison.OrdinalIgnoreCase) != true) continue;
            parameters[parameterName] = capability.Value;
        }
        return Parse(parameters);
    }

    public static ImageSizeControlCapabilityState Parse(IReadOnlyDictionary<string, bool>? parameterCapabilities)
    {
        if (parameterCapabilities is null) return new ImageSizeControlCapabilityState();
        var relevant = parameterCapabilities
            .Where(x => x.Key.StartsWith(ParameterPrefix, StringComparison.OrdinalIgnoreCase) && x.Value)
            .Select(x => x.Key)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (relevant.Count == 0) return new ImageSizeControlCapabilityState();
        if (relevant.Contains("image_size.none"))
            return new ImageSizeControlCapabilityState { Mode = ImageSizeControlModes.None };

        var usePrompt = relevant.Contains("image_size.prompt");
        var fieldFormat = relevant.Contains("image_size.field.image_config_aspect_ratio")
            ? ImageSizeFieldFormats.ImageConfigAspectRatio
            : relevant.Contains("image_size.field.aspect_ratio")
                ? ImageSizeFieldFormats.AspectRatio
                : relevant.Contains("image_size.field.width_height")
                    ? ImageSizeFieldFormats.WidthHeight
                    : relevant.Contains("image_size.field.size")
                        ? ImageSizeFieldFormats.Size
                        : null;

        return new ImageSizeControlCapabilityState
        {
            Mode = fieldFormat is null
                ? usePrompt ? ImageSizeControlModes.Prompt : ImageSizeControlModes.Inherit
                : usePrompt ? ImageSizeControlModes.FieldAndPrompt : ImageSizeControlModes.Field,
            FieldFormat = fieldFormat,
        };
    }
}
