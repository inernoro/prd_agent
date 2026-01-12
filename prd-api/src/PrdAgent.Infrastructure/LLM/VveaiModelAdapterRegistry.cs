using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// vveai 平台模型适配器注册表
/// 负责模型匹配、尺寸归一化、参数转换
/// </summary>
public static class VveaiModelAdapterRegistry
{
    private static readonly Regex SizeRegex = new(@"^\s*(\d+)\s*[xX×＊*]\s*(\d+)\s*$", RegexOptions.Compiled);

    /// <summary>
    /// 根据平台 URL 和模型名匹配适配配置
    /// </summary>
    public static VveaiModelAdapterConfig? TryMatch(string? platformApiUrl, string? modelName)
    {
        if (string.IsNullOrWhiteSpace(modelName)) return null;
        if (!VveaiModelConfigs.IsVveaiPlatform(platformApiUrl)) return null;

        var name = modelName.Trim().ToLowerInvariant();

        foreach (var config in VveaiModelConfigs.Configs)
        {
            if (MatchPattern(config.ModelIdPattern, name))
            {
                return config;
            }
        }

        return null;
    }

    /// <summary>
    /// 根据模型名获取适配信息（不检查平台 URL）
    /// </summary>
    public static VveaiModelAdapterConfig? GetConfigByModelName(string? modelName)
    {
        if (string.IsNullOrWhiteSpace(modelName)) return null;
        var name = modelName.Trim().ToLowerInvariant();

        foreach (var config in VveaiModelConfigs.Configs)
        {
            if (MatchPattern(config.ModelIdPattern, name))
            {
                return config;
            }
        }

        return null;
    }

    /// <summary>
    /// 尺寸归一化：将请求的尺寸适配到模型支持的尺寸
    /// </summary>
    public static SizeAdaptationResult NormalizeSize(VveaiModelAdapterConfig config, string? requestedSize)
    {
        var result = new SizeAdaptationResult();

        // 解析请求尺寸
        if (!TryParseSize(requestedSize, out var reqW, out var reqH))
        {
            // 无法解析：使用默认尺寸
            var defaultSize = config.AllowedSizes.FirstOrDefault() ?? "1024x1024";
            TryParseSize(defaultSize, out var dw, out var dh);
            result.Size = defaultSize;
            result.Width = dw;
            result.Height = dh;
            result.AspectRatio = DetectAspectRatio(dw, dh, config.AllowedRatios);
            result.Resolution = DetectResolution(dw, dh);
            result.SizeAdjusted = true;
            return result;
        }

        switch (config.SizeConstraintType)
        {
            case SizeConstraintTypes.Whitelist:
                return NormalizeSizeWhitelist(config, reqW, reqH);

            case SizeConstraintTypes.Range:
                return NormalizeSizeRange(config, reqW, reqH);

            case SizeConstraintTypes.AspectRatio:
                return NormalizeSizeAspectRatio(config, reqW, reqH);

            default:
                // 回退到白名单模式
                return NormalizeSizeWhitelist(config, reqW, reqH);
        }
    }

    /// <summary>
    /// 白名单模式：选择最接近的尺寸
    /// </summary>
    private static SizeAdaptationResult NormalizeSizeWhitelist(VveaiModelAdapterConfig config, int reqW, int reqH)
    {
        var result = new SizeAdaptationResult();
        var reqRatio = (double)reqW / reqH;
        var reqArea = (long)reqW * reqH;

        string? bestSize = null;
        double bestScore = double.MaxValue;
        int bestW = 1024, bestH = 1024;

        foreach (var sizeStr in config.AllowedSizes)
        {
            if (!TryParseSize(sizeStr, out var w, out var h)) continue;

            var ratio = (double)w / h;
            var area = (long)w * h;

            // 评分：比例差异权重 0.7，面积差异权重 0.3
            var ratioDiff = Math.Abs(reqRatio - ratio) / Math.Max(reqRatio, 0.001);
            var areaDiff = Math.Abs(reqArea - area) / (double)Math.Max(reqArea, 1);
            var score = ratioDiff * 0.7 + areaDiff * 0.3;

            if (score < bestScore)
            {
                bestScore = score;
                bestSize = sizeStr;
                bestW = w;
                bestH = h;
            }
        }

        result.Size = bestSize ?? "1024x1024";
        result.Width = bestW;
        result.Height = bestH;
        result.AspectRatio = DetectAspectRatio(bestW, bestH, config.AllowedRatios);
        result.Resolution = DetectResolution(bestW, bestH);
        result.SizeAdjusted = bestW != reqW || bestH != reqH;
        result.RatioAdjusted = IsRatioSignificantlyDifferent(reqW, reqH, bestW, bestH, 0.05);

        return result;
    }

    /// <summary>
    /// 范围模式：在范围内调整尺寸
    /// </summary>
    private static SizeAdaptationResult NormalizeSizeRange(VveaiModelAdapterConfig config, int reqW, int reqH)
    {
        var result = new SizeAdaptationResult();

        var w = reqW;
        var h = reqH;

        // 应用范围限制
        if (config.MinWidth.HasValue) w = Math.Max(w, config.MinWidth.Value);
        if (config.MaxWidth.HasValue) w = Math.Min(w, config.MaxWidth.Value);
        if (config.MinHeight.HasValue) h = Math.Max(h, config.MinHeight.Value);
        if (config.MaxHeight.HasValue) h = Math.Min(h, config.MaxHeight.Value);

        // 应用像素总量限制
        if (config.MaxPixels.HasValue && (long)w * h > config.MaxPixels.Value)
        {
            var scale = Math.Sqrt((double)config.MaxPixels.Value / ((long)w * h));
            w = (int)(w * scale);
            h = (int)(h * scale);
        }

        // 应用整除要求
        if (config.MustBeDivisibleBy.HasValue && config.MustBeDivisibleBy.Value > 1)
        {
            var div = config.MustBeDivisibleBy.Value;
            w = (w / div) * div;
            h = (h / div) * div;
            // 确保不小于最小值
            if (config.MinWidth.HasValue && w < config.MinWidth.Value)
                w = ((config.MinWidth.Value + div - 1) / div) * div;
            if (config.MinHeight.HasValue && h < config.MinHeight.Value)
                h = ((config.MinHeight.Value + div - 1) / div) * div;
        }

        result.Size = $"{w}x{h}";
        result.Width = w;
        result.Height = h;
        result.AspectRatio = DetectAspectRatio(w, h, config.AllowedRatios);
        result.Resolution = DetectResolution(w, h);
        result.SizeAdjusted = w != reqW || h != reqH;
        result.RatioAdjusted = IsRatioSignificantlyDifferent(reqW, reqH, w, h, 0.05);

        return result;
    }

    /// <summary>
    /// 比例模式：只返回比例和分辨率档位
    /// </summary>
    private static SizeAdaptationResult NormalizeSizeAspectRatio(VveaiModelAdapterConfig config, int reqW, int reqH)
    {
        var result = new SizeAdaptationResult();

        var reqRatio = (double)reqW / reqH;
        var bestRatio = FindClosestRatio(reqRatio, config.AllowedRatios);

        // 如果有白名单尺寸，选择最接近的
        if (config.AllowedSizes.Count > 0)
        {
            var whitelist = NormalizeSizeWhitelist(config, reqW, reqH);
            result.Size = whitelist.Size;
            result.Width = whitelist.Width;
            result.Height = whitelist.Height;
        }
        else
        {
            // 没有白名单尺寸，使用默认
            result.Size = "1024x1024";
            result.Width = 1024;
            result.Height = 1024;
        }

        result.AspectRatio = bestRatio ?? "1:1";
        result.Resolution = DetectResolution(reqW, reqH);
        result.SizeAdjusted = true; // 比例模式总是需要转换
        result.RatioAdjusted = bestRatio != null && !IsRatioMatch(reqW, reqH, bestRatio, 0.05);

        return result;
    }

    /// <summary>
    /// 转换参数（应用 ParamRenames）
    /// </summary>
    public static Dictionary<string, object> TransformParams(
        VveaiModelAdapterConfig config,
        Dictionary<string, object> originalParams)
    {
        var result = new Dictionary<string, object>(originalParams);

        foreach (var rename in config.ParamRenames)
        {
            if (result.TryGetValue(rename.Key, out var value))
            {
                result.Remove(rename.Key);
                result[rename.Value] = value;
            }
        }

        return result;
    }

    /// <summary>
    /// 构建尺寸参数（根据 SizeParamFormat）
    /// </summary>
    public static void ApplySizeParams(
        VveaiModelAdapterConfig config,
        SizeAdaptationResult sizeResult,
        Dictionary<string, object> targetParams)
    {
        switch (config.SizeParamFormat)
        {
            case SizeParamFormats.WxH:
                targetParams["size"] = sizeResult.Size;
                break;

            case SizeParamFormats.WidthHeight:
                targetParams["width"] = sizeResult.Width;
                targetParams["height"] = sizeResult.Height;
                targetParams.Remove("size");
                break;

            case SizeParamFormats.AspectRatio:
                targetParams["aspect_ratio"] = sizeResult.AspectRatio ?? "1:1";
                targetParams.Remove("size");
                if (config.RequiresResolutionParam && !string.IsNullOrEmpty(sizeResult.Resolution))
                {
                    targetParams["resolution"] = sizeResult.Resolution;
                }
                break;
        }
    }

    /// <summary>
    /// 获取适配器信息（供前端展示）
    /// </summary>
    public static VveaiAdapterInfo? GetAdapterInfo(string? platformApiUrl, string? modelName)
    {
        var config = TryMatch(platformApiUrl, modelName);
        if (config == null) return null;

        return new VveaiAdapterInfo
        {
            Matched = true,
            AdapterName = config.ModelIdPattern.TrimEnd('*'),
            DisplayName = config.DisplayName,
            Provider = config.Provider,
            SizeConstraintType = config.SizeConstraintType,
            SizeConstraintDescription = config.SizeConstraintDescription,
            AllowedSizes = config.AllowedSizes,
            AllowedRatios = config.AllowedRatios,
            SizeParamFormat = config.SizeParamFormat,
            MustBeDivisibleBy = config.MustBeDivisibleBy,
            MaxWidth = config.MaxWidth,
            MaxHeight = config.MaxHeight,
            MinWidth = config.MinWidth,
            MinHeight = config.MinHeight,
            MaxPixels = config.MaxPixels,
            Notes = config.Notes,
            SupportsImageToImage = config.SupportsImageToImage,
            SupportsInpainting = config.SupportsInpainting,
        };
    }

    #region Helper Methods

    private static bool MatchPattern(string pattern, string input)
    {
        if (string.IsNullOrWhiteSpace(pattern)) return false;
        var p = pattern.Trim().ToLowerInvariant();

        if (p.EndsWith("*"))
        {
            var prefix = p.TrimEnd('*');
            return input.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        return string.Equals(p, input, StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryParseSize(string? size, out int w, out int h)
    {
        w = 0;
        h = 0;
        if (string.IsNullOrWhiteSpace(size)) return false;

        var m = SizeRegex.Match(size);
        if (!m.Success) return false;

        if (!int.TryParse(m.Groups[1].Value, out w)) return false;
        if (!int.TryParse(m.Groups[2].Value, out h)) return false;

        return w > 0 && h > 0;
    }

    private static string? DetectAspectRatio(int w, int h, List<string> allowedRatios)
    {
        if (w <= 0 || h <= 0) return null;
        var ratio = (double)w / h;
        return FindClosestRatio(ratio, allowedRatios);
    }

    private static string? FindClosestRatio(double ratio, List<string> allowedRatios)
    {
        if (allowedRatios.Count == 0) return null;

        string? best = null;
        double bestDiff = double.MaxValue;

        foreach (var r in allowedRatios)
        {
            var parts = r.Split(':');
            if (parts.Length != 2) continue;
            if (!double.TryParse(parts[0], out var a) || !double.TryParse(parts[1], out var b)) continue;
            if (b == 0) continue;

            var optRatio = a / b;
            var diff = Math.Abs(ratio - optRatio);
            if (diff < bestDiff)
            {
                bestDiff = diff;
                best = r;
            }
        }

        return best;
    }

    private static bool IsRatioMatch(int w, int h, string ratioStr, double threshold)
    {
        if (w <= 0 || h <= 0) return false;
        var parts = ratioStr.Split(':');
        if (parts.Length != 2) return false;
        if (!double.TryParse(parts[0], out var a) || !double.TryParse(parts[1], out var b)) return false;
        if (b == 0) return false;

        var actual = (double)w / h;
        var target = a / b;
        return Math.Abs(actual - target) / target < threshold;
    }

    private static bool IsRatioSignificantlyDifferent(int w1, int h1, int w2, int h2, double threshold)
    {
        if (w1 <= 0 || h1 <= 0 || w2 <= 0 || h2 <= 0) return false;
        var r1 = (double)w1 / h1;
        var r2 = (double)w2 / h2;
        return Math.Abs(r1 - r2) / r1 > threshold;
    }

    private static string DetectResolution(int w, int h)
    {
        var area = (long)w * h;
        if (area >= 8_000_000) return "4k";
        if (area >= 2_500_000) return "2k";
        return "1k";
    }

    #endregion
}

/// <summary>
/// 适配器信息（供前端展示）
/// </summary>
public class VveaiAdapterInfo
{
    public bool Matched { get; set; }
    public string AdapterName { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public string SizeConstraintType { get; set; } = string.Empty;
    public string SizeConstraintDescription { get; set; } = string.Empty;
    public List<string> AllowedSizes { get; set; } = new();
    public List<string> AllowedRatios { get; set; } = new();
    public string SizeParamFormat { get; set; } = string.Empty;
    public int? MustBeDivisibleBy { get; set; }
    public int? MaxWidth { get; set; }
    public int? MaxHeight { get; set; }
    public int? MinWidth { get; set; }
    public int? MinHeight { get; set; }
    public long? MaxPixels { get; set; }
    public List<string> Notes { get; set; } = new();
    public bool SupportsImageToImage { get; set; }
    public bool SupportsInpainting { get; set; }
}
