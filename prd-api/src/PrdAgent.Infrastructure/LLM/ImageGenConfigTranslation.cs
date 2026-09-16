using MongoDB.Bson;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// 生图契约在「库里的数据行」与「运行时配置对象」之间的翻译。
///
/// 放在基础设施而不是那个刷新器里，有两个理由：判定入口
/// <see cref="ImageGenModelAdapterRegistry"/> 就在这一层，翻译紧挨着它才好一起读；
/// 而且守卫项目不引用 PrdAgent.Api——翻译留在 worker 里，
/// 「漏接一个字段」这种静默坏法就没有任何东西够得着它。
/// </summary>
public static class ImageGenConfigTranslation
{
    /// <summary>
    /// 内置配置翻成控制台那边认的形状。字段与 <see cref="ToAdapterConfig"/> 对称——
    /// 一边少一个字段，「照着内置那条改」就会悄悄丢掉那一项。
    /// </summary>
    public static BsonDocument BuiltinToBson(ImageGenModelAdapterConfig c)
    {
        var sizes = new BsonDocument();
        foreach (var (bucket, list) in c.SizesByResolution)
            sizes[bucket] = new BsonArray((list ?? []).Select(x => x.Size).Where(x => !string.IsNullOrWhiteSpace(x)));

        var renames = new BsonDocument();
        foreach (var (from, to) in c.ParamRenames) renames[from] = to;

        return new BsonDocument
        {
            { "ModelIdPattern", c.ModelIdPattern },
            { "DisplayName", c.DisplayName ?? string.Empty },
            { "Provider", c.Provider ?? string.Empty },
            { "PlatformType", (BsonValue?)c.PlatformType ?? BsonNull.Value },
            { "OfficialDocUrl", (BsonValue?)c.OfficialDocUrl ?? BsonNull.Value },
            { "SizeConstraintType", c.SizeConstraintType ?? string.Empty },
            { "SizeConstraintDescription", c.SizeConstraintDescription ?? string.Empty },
            { "SizesByResolution", sizes },
            { "SizesNotApplicable", c.SizesNotApplicable },
            { "SizeParamFormat", c.SizeParamFormat ?? string.Empty },
            { "InjectSizePrompt", c.InjectSizePrompt },
            { "MustBeDivisibleBy", (BsonValue?)c.MustBeDivisibleBy ?? BsonNull.Value },
            { "MaxWidth", (BsonValue?)c.MaxWidth ?? BsonNull.Value },
            { "MaxHeight", (BsonValue?)c.MaxHeight ?? BsonNull.Value },
            { "MinWidth", (BsonValue?)c.MinWidth ?? BsonNull.Value },
            { "MinHeight", (BsonValue?)c.MinHeight ?? BsonNull.Value },
            { "MaxPixels", (BsonValue?)c.MaxPixels ?? BsonNull.Value },
            { "ParamRenames", renames },
            { "RequiresResolutionParam", c.RequiresResolutionParam },
            { "SupportsImageToImage", c.SupportsImageToImage },
            { "SupportsInpainting", c.SupportsInpainting },
            { "SupportsResponseFormat", c.SupportsResponseFormat },
            { "Notes", new BsonArray(c.Notes ?? []) },
        };
    }

    /// <summary>
    /// 数据行翻成注册表认识的那个配置对象。
    ///
    /// 字段是逐个对着 <see cref="ImageGenModelAdapterConfig"/> 抄的——漏一个，
    /// 控制台上那一栏就成了填了没用的摆设，而且不会有任何东西变红。
    /// `ImageGenConfigOverrideGuardTests` 逐字段比对两边，防的正是这种静默漏接。
    /// </summary>
    public static ImageGenModelAdapterConfig ToAdapterConfig(GatewayImageModelConfig doc)
    {
        var sizes = new Dictionary<string, List<SizeOption>>(StringComparer.OrdinalIgnoreCase)
        {
            ["1k"] = [],
            ["2k"] = [],
            ["4k"] = [],
        };
        foreach (var (bucket, list) in doc.SizesByResolution)
        {
            if (string.IsNullOrWhiteSpace(bucket)) continue;
            var target = sizes.TryGetValue(bucket, out var existing) ? existing : sizes[bucket] = [];
            foreach (var raw in list ?? [])
            {
                var option = ParseSizeOption(raw);
                if (option is not null) target.Add(option);
            }
        }

        return new ImageGenModelAdapterConfig
        {
            ModelIdPattern = doc.ModelIdPattern.Trim(),
            DisplayName = doc.DisplayName,
            Provider = doc.Provider,
            PlatformType = string.IsNullOrWhiteSpace(doc.PlatformType) ? null : doc.PlatformType.Trim(),
            OfficialDocUrl = doc.OfficialDocUrl,
            LastUpdated = doc.UpdatedAt.ToString("yyyy-MM-dd"),
            SizeConstraintType = string.IsNullOrWhiteSpace(doc.SizeConstraintType)
                ? SizeConstraintTypes.Whitelist
                : doc.SizeConstraintType.Trim(),
            SizeConstraintDescription = doc.SizeConstraintDescription,
            SizesByResolution = sizes,
            SizesNotApplicable = doc.SizesNotApplicable,
            SizeParamFormat = string.IsNullOrWhiteSpace(doc.SizeParamFormat)
                ? SizeParamFormats.WxH
                : doc.SizeParamFormat.Trim(),
            InjectSizePrompt = doc.InjectSizePrompt,
            MustBeDivisibleBy = doc.MustBeDivisibleBy,
            MaxWidth = doc.MaxWidth,
            MaxHeight = doc.MaxHeight,
            MinWidth = doc.MinWidth,
            MinHeight = doc.MinHeight,
            MaxPixels = doc.MaxPixels,
            ParamRenames = new Dictionary<string, string>(doc.ParamRenames, StringComparer.OrdinalIgnoreCase),
            RequiresResolutionParam = doc.RequiresResolutionParam,
            SupportsImageToImage = doc.SupportsImageToImage,
            SupportsInpainting = doc.SupportsInpainting,
            SupportsResponseFormat = doc.SupportsResponseFormat,
            Notes = [.. doc.Notes],
        };
    }

    /// <summary>
    /// 尺寸串 `宽x高` 翻成选项。比例由宽高算出来而不是另存一份——
    /// 存两份迟早对不上（形状 3），而且填的人还要自己算最大公约数。
    /// </summary>
    private static SizeOption? ParseSizeOption(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var parts = raw.Trim().Split(['x', 'X', '×', '*'], StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 2) return null;
        if (!int.TryParse(parts[0].Trim(), out var w) || !int.TryParse(parts[1].Trim(), out var h)) return null;
        if (w <= 0 || h <= 0) return null;

        var g = Gcd(w, h);
        return new SizeOption($"{w}x{h}", $"{w / g}:{h / g}");
    }

    private static int Gcd(int a, int b)
    {
        while (b != 0) (a, b) = (b, a % b);
        return a == 0 ? 1 : a;
    }
}
