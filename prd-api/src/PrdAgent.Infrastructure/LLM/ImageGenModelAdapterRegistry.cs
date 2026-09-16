using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// 生图模型适配器注册表
/// 负责模型匹配、尺寸归一化、参数转换
/// 基于模型名匹配，适用于所有平台
/// </summary>
public static class ImageGenModelAdapterRegistry
{
    /// <summary>GPT Image 固定返回 base64；未知兼容模型仍保留原有参数契约。</summary>
    public static bool SupportsResponseFormat(string? modelName)
    {
        var name = modelName?.Trim() ?? string.Empty;
        return !name.StartsWith("gpt-image-", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(name, "chatgpt-image-latest", StringComparison.OrdinalIgnoreCase)
            && TryMatch(name)?.SupportsResponseFormat != false;
    }

    private static readonly Regex SizeRegex = new(@"^\s*(\d+)\s*[xX×＊*]\s*(\d+)\s*$", RegexOptions.Compiled);

    /// <summary>
    /// 控制台里配的那份契约（<c>llmgw_imagegen_model_configs</c>）的内存快照。
    ///
    /// 静态可变状态，因为这个注册表的 18 个调用点全是静态方法、拿不到 DI 容器；
    /// 改成实例要动 18 处，收益只有「看起来更规范」。所以走**整表原子替换**：
    /// 刷新器算好一份新列表后一次性赋值，读侧永远看到某一版完整的表，
    /// 不会读到改了一半的中间态。绝不就地改这个列表。
    /// </summary>
    private static volatile IReadOnlyList<ImageGenModelAdapterConfig> _overrides = [];

    /// <summary>
    /// 换上一份新的覆盖表。只由 <c>ImageGenModelConfigSyncWorker</c> 调用。
    ///
    /// 传空列表 = 回到纯代码内置那 26 条，这也是库里一行都没有时的状态——
    /// 所以这套机制是纯增量的：不配任何东西，行为与 2026-09-16 之前逐字节相同。
    /// </summary>
    public static void ReplaceOverrides(IReadOnlyList<ImageGenModelAdapterConfig>? configs)
        => _overrides = configs is null ? [] : [.. configs];

    /// <summary>当前生效的覆盖条数。控制台与自检端点用它回答「我配的那条到底生效没有」。</summary>
    public static int OverrideCount => _overrides.Count;

    /// <summary>
    /// 根据模型名匹配适配配置（纯粹基于模型名，不检查平台）。
    ///
    /// **这是全链路唯一的判定入口**，合并规则收在这里面：先走控制台配的覆盖表，
    /// 没命中才回落到代码内置的那 26 条。谁都不许绕过它去直接遍历
    /// <c>ImageGenModelConfigs.Configs</c>——那样同一个问题就有了两个答案
    /// （predicate-and-wiring-discipline 形状 3），守卫
    /// `ImageGenConfigOverrideGuardTests` 钉住这一条。
    /// </summary>
    public static ImageGenModelAdapterConfig? TryMatch(string? modelName)
    {
        if (string.IsNullOrWhiteSpace(modelName)) return null;

        var name = modelName.Trim().ToLowerInvariant();

        // 覆盖表优先。它已经由刷新器按 MatchOrder、再按模式长度降序排好，
        // 这里只按顺序取第一个命中的，与代码表用的是同一个 MatchPattern。
        foreach (var config in _overrides)
        {
            if (MatchPattern(config.ModelIdPattern, name))
            {
                return config;
            }
        }

        foreach (var config in ImageGenModelConfigs.Configs)
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
    public static SizeAdaptationResult NormalizeSize(ImageGenModelAdapterConfig config, string? requestedSize)
    {
        // 自适应：不做尺寸归一化，输出尺寸由 prompt 决定
        if (config.SizeConstraintType == SizeConstraintTypes.Adaptive)
        {
            TryParseSize(requestedSize, out var aw, out var ah);
            return new SizeAdaptationResult
            {
                Size = string.IsNullOrWhiteSpace(requestedSize) ? string.Empty : requestedSize.Trim(),
                Width = aw,
                Height = ah,
                AspectRatio = aw > 0 && ah > 0 ? FindClosestRatio((double)aw / ah, GetAllRatiosFromConfig(config)) : null,
                IsAdaptive = true,
                SizeAdjusted = false,
                RatioAdjusted = false,
            };
        }

        var result = new SizeAdaptationResult();
        var allSizes = GetAllSizesFromConfig(config);
        var allRatios = GetAllRatiosFromConfig(config);

        // 解析请求尺寸
        if (!TryParseSize(requestedSize, out var reqW, out var reqH))
        {
            // 无法解析：使用默认尺寸
            var defaultSize = allSizes.FirstOrDefault() ?? "1024x1024";
            TryParseSize(defaultSize, out var dw, out var dh);
            result.Size = defaultSize;
            result.Width = dw;
            result.Height = dh;
            result.AspectRatio = DetectAspectRatio(dw, dh, allRatios);
            result.Resolution = DetectResolution(dw, dh);
            result.SizeAdjusted = true;
            return result;
        }

        switch (config.SizeConstraintType)
        {
            case SizeConstraintTypes.Whitelist:
                return NormalizeSizeWhitelist(config, reqW, reqH, allSizes, allRatios);

            case SizeConstraintTypes.Range:
                return NormalizeSizeRange(config, reqW, reqH, allRatios);

            case SizeConstraintTypes.AspectRatio:
                return NormalizeSizeAspectRatio(config, reqW, reqH, allSizes, allRatios);

            default:
                // 回退到白名单模式
                return NormalizeSizeWhitelist(config, reqW, reqH, allSizes, allRatios);
        }
    }

    /// <summary>
    /// 白名单模式：选择最接近的尺寸
    /// 优先在同一分辨率档位内匹配，避免跨档位降级（如用户选 2K 却匹配到 1K）
    /// </summary>
    private static SizeAdaptationResult NormalizeSizeWhitelist(ImageGenModelAdapterConfig config, int reqW, int reqH, List<string> allSizes, List<string> allRatios)
    {
        var reqTier = DetectResolution(reqW, reqH);

        // 第一轮：仅在同档位内匹配
        var sameTierSizes = allSizes.Where(s => TryParseSize(s, out var sw, out var sh) && DetectResolution(sw, sh) == reqTier).ToList();
        if (sameTierSizes.Count > 0)
        {
            var result = ScoreBestSize(sameTierSizes, reqW, reqH, allRatios);
            if (result != null) return result;
        }

        // 第二轮：同档位无匹配，回退到全量尺寸
        var fallback = ScoreBestSize(allSizes, reqW, reqH, allRatios);
        return fallback ?? new SizeAdaptationResult
        {
            Size = "1024x1024", Width = 1024, Height = 1024,
            AspectRatio = DetectAspectRatio(1024, 1024, allRatios),
            Resolution = "1k", SizeAdjusted = true,
        };
    }

    /// <summary>
    /// 从候选尺寸列表中评分选出最佳匹配
    /// </summary>
    private static SizeAdaptationResult? ScoreBestSize(List<string> candidates, int reqW, int reqH, List<string> allRatios)
    {
        var reqRatio = (double)reqW / reqH;
        var reqArea = (long)reqW * reqH;

        string? bestSize = null;
        double bestScore = double.MaxValue;
        int bestW = 0, bestH = 0;

        foreach (var sizeStr in candidates)
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

        if (bestSize == null) return null;

        return new SizeAdaptationResult
        {
            Size = bestSize,
            Width = bestW,
            Height = bestH,
            AspectRatio = DetectAspectRatio(bestW, bestH, allRatios),
            Resolution = DetectResolution(bestW, bestH),
            SizeAdjusted = bestW != reqW || bestH != reqH,
            RatioAdjusted = IsRatioSignificantlyDifferent(reqW, reqH, bestW, bestH, 0.05),
        };
    }

    /// <summary>
    /// 范围模式：在范围内调整尺寸
    /// </summary>
    private static SizeAdaptationResult NormalizeSizeRange(ImageGenModelAdapterConfig config, int reqW, int reqH, List<string> allRatios)
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

            // 缩放之后必须**重新套一遍边界**。
            //
            // 缩放是按长宽比等比做的，它不认识最小值：4096x512 在 1M 像素上限下缩成约
            // 2896x362，而契约声明的最小高是 512——发出去的尺寸违反了这条契约自己写的规矩，
            // 而没有任何地方会报错（形状 8：声明在那儿，运行时并不遵守它）。
            // 契约本身是否有解在写入侧已经拦过（最小宽高的乘积不得超过像素上限），
            // 所以这里重新套边界不会把两条约束推成互相矛盾。
            if (config.MinWidth.HasValue) w = Math.Max(w, config.MinWidth.Value);
            if (config.MaxWidth.HasValue) w = Math.Min(w, config.MaxWidth.Value);
            if (config.MinHeight.HasValue) h = Math.Max(h, config.MinHeight.Value);
            if (config.MaxHeight.HasValue) h = Math.Min(h, config.MaxHeight.Value);
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
            // 向下取整可能把边长抹成 0（请求边小于除数时），向上取整又可能越过最大值。
            // 两头都要兜：没有最小值托底时至少给一个除数，越过最大值就退到不超过它的最大倍数。
            if (w <= 0) w = div;
            if (h <= 0) h = div;
            if (config.MaxWidth.HasValue && w > config.MaxWidth.Value)
                w = Math.Max(div, (config.MaxWidth.Value / div) * div);
            if (config.MaxHeight.HasValue && h > config.MaxHeight.Value)
                h = Math.Max(div, (config.MaxHeight.Value / div) * div);
        }

        result.Size = $"{w}x{h}";
        result.Width = w;
        result.Height = h;
        result.AspectRatio = DetectAspectRatio(w, h, allRatios);
        result.Resolution = DetectResolution(w, h);
        result.SizeAdjusted = w != reqW || h != reqH;
        result.RatioAdjusted = IsRatioSignificantlyDifferent(reqW, reqH, w, h, 0.05);

        return result;
    }

    /// <summary>
    /// 比例模式：只返回比例和分辨率档位
    /// </summary>
    private static SizeAdaptationResult NormalizeSizeAspectRatio(ImageGenModelAdapterConfig config, int reqW, int reqH, List<string> allSizes, List<string> allRatios)
    {
        var result = new SizeAdaptationResult();

        var reqRatio = (double)reqW / reqH;
        var bestRatio = FindClosestRatio(reqRatio, allRatios);

        // 如果有白名单尺寸，选择最接近的
        if (allSizes.Count > 0)
        {
            var whitelist = NormalizeSizeWhitelist(config, reqW, reqH, allSizes, allRatios);
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
        ImageGenModelAdapterConfig config,
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
        ImageGenModelAdapterConfig config,
        SizeAdaptationResult sizeResult,
        Dictionary<string, object> targetParams)
    {
        // 声明了「这个模型没有尺寸概念」就一个尺寸参数都不发。
        //
        // 短路放在这里而不是写入侧：SizesNotApplicable 与 SizeParamFormat / SizeConstraintType
        // 是三个独立字段，写入侧要拦就得穷举它们的组合，漏一种就又回到「界面说没有尺寸、
        // 实际发了 1024x1024」——而那个值还是 NormalizeSize 在白名单为空时兜出来的默认值，
        // 上游可能直接拒掉（形状 3：同一个不变量散在多处各自判，不如收在唯一的出口）。
        if (config.SizesNotApplicable)
        {
            targetParams.Remove("size");
            targetParams.Remove("width");
            targetParams.Remove("height");
            targetParams.Remove("aspect_ratio");
            targetParams.Remove("resolution");
            return;
        }

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

            case SizeParamFormats.None:
                // 自适应模型：不注入任何尺寸参数，并清掉调用方可能误传的 size/width/height/aspect_ratio
                targetParams.Remove("size");
                targetParams.Remove("width");
                targetParams.Remove("height");
                targetParams.Remove("aspect_ratio");
                targetParams.Remove("resolution");
                break;
        }
    }

    /// <summary>
    /// 获取适配器信息（供前端展示）
    /// </summary>
    public static ImageGenAdapterInfo? GetAdapterInfo(string? modelName)
    {
        var config = TryMatch(modelName);
        if (config == null) return null;

        return new ImageGenAdapterInfo
        {
            Matched = true,
            AdapterName = config.ModelIdPattern.TrimEnd('*'),
            DisplayName = config.DisplayName,
            Provider = config.Provider,
            OfficialDocUrl = config.OfficialDocUrl,
            LastUpdated = config.LastUpdated,
            SizeConstraintType = config.SizeConstraintType,
            SizeConstraintDescription = config.SizeConstraintDescription,
            // 直接返回按分辨率分组的尺寸配置，前端无需转换
            SizesByResolution = config.SizesByResolution,
            SizeParamFormat = config.SizeParamFormat,
            SizesNotApplicable = config.SizesNotApplicable,
            MustBeDivisibleBy = config.MustBeDivisibleBy,
            MaxWidth = config.MaxWidth,
            MaxHeight = config.MaxHeight,
            MinWidth = config.MinWidth,
            MinHeight = config.MinHeight,
            MaxPixels = config.MaxPixels,
            Notes = config.Notes,
            SupportsImageToImage = config.SupportsImageToImage,
            SupportsInpainting = config.SupportsInpainting,
            IsAdaptive = config.SizeConstraintType == SizeConstraintTypes.Adaptive,
        };
    }

    /// <summary>
    /// 从 SizesByResolution 获取所有尺寸的扁平列表（用于内部尺寸归一化）
    /// </summary>
    public static List<string> GetAllSizesFromConfig(ImageGenModelAdapterConfig config)
    {
        var sizes = new List<string>();
        foreach (var tier in config.SizesByResolution.Values)
        {
            foreach (var opt in tier)
            {
                if (!string.IsNullOrEmpty(opt.Size))
                    sizes.Add(opt.Size);
            }
        }
        return sizes;
    }

    /// <summary>
    /// 从 SizesByResolution 获取所有比例的扁平列表（用于内部尺寸归一化）
    /// </summary>
    public static List<string> GetAllRatiosFromConfig(ImageGenModelAdapterConfig config)
    {
        var ratios = new HashSet<string>();
        foreach (var tier in config.SizesByResolution.Values)
        {
            foreach (var opt in tier)
            {
                if (!string.IsNullOrEmpty(opt.AspectRatio))
                    ratios.Add(opt.AspectRatio);
            }
        }
        return ratios.ToList();
    }

    /// <summary>
    /// 一站式构建生图请求参数（尺寸适配 + 参数格式转换 + 参数重命名）
    /// 调用方只需使用返回的 SizeParams 和 OtherParams，无需了解底层参数格式差异
    /// </summary>
    /// <param name="modelName">模型名称（用于匹配适配器）</param>
    /// <param name="requestedSize">请求的尺寸（WxH 格式，如 "1024x1024"）</param>
    /// <param name="extraParams">额外参数（会应用 ParamRenames 重命名）</param>
    /// <returns>构建好的请求参数</returns>
    public static ImageGenRequestParams BuildRequestParams(
        string? modelName,
        string? requestedSize,
        Dictionary<string, object>? extraParams = null)
    {
        var result = new ImageGenRequestParams();

        var config = TryMatch(modelName);
        if (config == null)
        {
            // 未匹配到适配器，返回默认 WxH 格式
            result.HasAdapter = false;
            result.SizeParamFormat = SizeParamFormats.WxH;
            result.SizeParams["size"] = string.IsNullOrWhiteSpace(requestedSize) ? "1024x1024" : requestedSize.Trim();
            result.Adaptation = new SizeAdaptationResult
            {
                Size = result.SizeParams["size"]?.ToString() ?? "1024x1024",
                Width = 1024,
                Height = 1024,
            };
            if (extraParams != null)
            {
                result.OtherParams = new Dictionary<string, object>(extraParams);
            }
            return result;
        }

        result.HasAdapter = true;
        result.AdapterName = config.ModelIdPattern;
        result.SizeParamFormat = config.SizeParamFormat;
        result.IsAdaptive = config.SizeConstraintType == SizeConstraintTypes.Adaptive;

        // 1. 尺寸归一化
        var sizeResult = NormalizeSize(config, requestedSize);
        result.Adaptation = sizeResult;

        // 2. 应用尺寸参数格式（WxH / width+height / aspect_ratio / none）
        ApplySizeParams(config, sizeResult, result.SizeParams);

        // 2.1 ParamRenames 同样作用到 SizeParams（如 aspect_ratio → aspectRatio for nano-banana-2）
        if (config.ParamRenames.Count > 0 && result.SizeParams.Count > 0)
        {
            result.SizeParams = TransformParams(config, result.SizeParams);
        }

        // 3. 参数重命名（如 model -> model_name）
        if (extraParams != null)
        {
            result.OtherParams = TransformParams(config, extraParams);
        }

        return result;
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

    internal static bool TryParseSize(string? size, out int w, out int h)
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
public class ImageGenAdapterInfo
{
    public bool Matched { get; set; }
    public string AdapterName { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public string? OfficialDocUrl { get; set; }
    public string? LastUpdated { get; set; }
    public string SizeConstraintType { get; set; } = string.Empty;
    public string SizeConstraintDescription { get; set; } = string.Empty;
    
    /// <summary>
    /// 按分辨率分组的尺寸选项（1k/2k/4k）
    /// 前端直接使用，无需转换
    /// </summary>
    public Dictionary<string, List<SizeOption>> SizesByResolution { get; set; } = new();
    
    public string SizeParamFormat { get; set; } = string.Empty;
    public bool SizesNotApplicable { get; set; }
    public int? MustBeDivisibleBy { get; set; }
    public int? MaxWidth { get; set; }
    public int? MaxHeight { get; set; }
    public int? MinWidth { get; set; }
    public int? MinHeight { get; set; }
    public long? MaxPixels { get; set; }
    public List<string> Notes { get; set; } = new();
    public bool SupportsImageToImage { get; set; }
    public bool SupportsInpainting { get; set; }

    /// <summary>是否为自适应模型：true 表示尺寸不通过 API 字段传输，不等于尺寸不可选择</summary>
    public bool IsAdaptive { get; set; }
}
