using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;

namespace PrdAgent.Infrastructure.LlmGateway.ImageGen;

/// <summary>网关发布的业务模型和技术能力；不包含 MAP 默认项或供应商凭据。</summary>
public sealed class GatewayImageModel
{
    public AvailableModelPool Model { get; set; } = new();
    public ImageGenAdapterInfo? ImageCapabilities { get; set; }
}

/// <summary>仅在 serving 执行。目录和请求适配共同使用同一模型能力注册表。</summary>
public static class GatewayImageModelCatalog
{
    public static string? ValidateRequest(GatewayCanonicalImageRequest request, GatewayModelResolution resolution)
    {
        if (string.IsNullOrWhiteSpace(request.Prompt)) return "请输入图片描述。";
        if (request.Count is < 1 or > 20) return "单次生成数量应为 1 至 20 张。";
        var info = Describe(resolution);
        if (info is null) return "该模型尚未提供图片能力配置，请联系管理员完善配置。";
        if (request.Images.Count > 0 && !info.SupportsImageToImage) return "该模型不支持参考图，请选择支持参考图的模型。";
        if (request.MaskBase64 is not null && (!info.SupportsInpainting || request.Images.Count == 0))
            return "该请求不支持局部重绘，请检查参考图和所选模型。";
        return ValidateSize(request.Size, info);
    }

    /// <summary>
    /// 尺寸是否被这个模型接受。网关执行前的校验与调用方入队前的预检共用这一处，
    /// 免得调用方按另一套口径放行、任务入队后才在这里被拒（MCP-LIT-18）。
    /// </summary>
    public static string? ValidateSize(string? size, ImageGenAdapterInfo info)
    {
        if (info.SizesNotApplicable || string.IsNullOrWhiteSpace(size)) return null;
        var parts = size.Split('x');
        if (parts.Length != 2 || !int.TryParse(parts[0], out var width) || !int.TryParse(parts[1], out var height)
            || width <= 0 || height <= 0) return "图片尺寸格式不正确，请重新选择尺寸。";
        if (info.SizeConstraintType == SizeConstraintTypes.Whitelist
            && !info.SizesByResolution.Values.SelectMany(x => x).Any(x => x.Size == size))
            return "该模型不支持此尺寸，请从模型提供的尺寸列表中选择。";
        if (width < info.MinWidth || height < info.MinHeight || width > info.MaxWidth || height > info.MaxHeight
            || (long)width * height > info.MaxPixels
            || (info.MustBeDivisibleBy is > 0 && (width % info.MustBeDivisibleBy != 0 || height % info.MustBeDivisibleBy != 0)))
            return "图片尺寸超出该模型的限制，请重新选择尺寸。";
        return null;
    }

    public static async Task<List<GatewayImageModel>> ReadAsync(
        ILlmGateway gateway, string appCallerCode, CancellationToken ct)
    {
        var catalog = new List<GatewayImageModel>();
        foreach (var model in await gateway.GetAvailablePoolsAsync(appCallerCode, ModelTypes.ImageGen, ct))
        {
            if (model.ResolutionType != "LogicalModel"
                || GatewayCapabilityIds.IsOperationOnly(model.Code, model.Capabilities)) continue;
            var capabilities = Describe(model);
            if (capabilities is null) continue;
            // 排序不是默认；默认模型由调用方业务配置决定。
            catalog.Add(new GatewayImageModel
            {
                Model = new AvailableModelPool
                {
                    Id = model.Id, Name = model.Name, Code = model.Code, Description = model.Description,
                    Priority = model.Priority, ResolutionType = model.ResolutionType,
                    Capabilities = model.Capabilities, Models = model.Models,
                },
                ImageCapabilities = capabilities,
            });
        }
        return catalog;
    }

    /// <summary>
    /// 从权威目录随条目下发的实际模型能力快照读取图片参数。
    /// 这是纯读取路径，不能再次 Resolve；否则一次打开选择器就可能认领半开线路租约。
    /// </summary>
    public static ImageGenAdapterInfo? Describe(AvailableModelPool model)
    {
        var member = model.Models.FirstOrDefault(item =>
            item.ImageCapabilities is not null || ImageSizeControlCapabilities.Parse(item.ParameterCapabilities).IsConfigured);
        var snapshot = member?.ImageCapabilities;
        if (snapshot is null)
            return member is null ? null : ApplySizeControl(new ImageGenAdapterInfo
            {
                Matched = true, AdapterName = model.Code, DisplayName = model.Name,
                SizeConstraintType = "upstream", SizeConstraintDescription = "由网关模型能力控制",
            }, member.ParameterCapabilities);

        var sizes = new Dictionary<string, List<SizeOption>>(StringComparer.OrdinalIgnoreCase);
        foreach (var (bucket, rawSizes) in snapshot.SizesByResolution)
        {
            sizes[bucket] = rawSizes
                .Select(raw => ParseSizeOption(raw, snapshot.AspectRatiosBySize))
                .Where(option => option is not null)
                .Cast<SizeOption>()
                .DistinctBy(option => option.Size, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        var info = new ImageGenAdapterInfo
        {
            Matched = true,
            AdapterName = model.Code,
            DisplayName = model.Name,
            SizeConstraintType = snapshot.SizeConstraintType,
            SizeConstraintDescription = snapshot.SizeConstraintDescription,
            SizesByResolution = sizes,
            SizeParamFormat = snapshot.SizeParamFormat,
            SizesNotApplicable = snapshot.SizesNotApplicable,
            MustBeDivisibleBy = snapshot.MustBeDivisibleBy,
            MaxWidth = snapshot.MaxWidth,
            MaxHeight = snapshot.MaxHeight,
            MinWidth = snapshot.MinWidth,
            MinHeight = snapshot.MinHeight,
            MaxPixels = snapshot.MaxPixels,
            Notes = [.. snapshot.Notes],
            SupportsImageToImage = snapshot.SupportsImageToImage,
            SupportsInpainting = snapshot.SupportsInpainting,
            IsAdaptive = snapshot.IsAdaptive,
        };
        return ApplySizeControl(info, member!.ParameterCapabilities);
    }

    private static SizeOption? ParseSizeOption(string? raw, IReadOnlyDictionary<string, string>? declaredAspects)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var parts = raw.Trim().Split(new[] { 'x', 'X', '×', '*' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 2
            || !int.TryParse(parts[0].Trim(), out var width)
            || !int.TryParse(parts[1].Trim(), out var height)
            || width <= 0 || height <= 0) return null;
        var size = $"{width}x{height}";
        var aspect = declaredAspects?.GetValueOrDefault(size);
        return new SizeOption(size, string.IsNullOrWhiteSpace(aspect) ? DescribeAspectRatio(width, height) : aspect);
    }

    /// <summary>旧快照没有比例字段时的通用显示标签，不改变像素或模型支持清单。</summary>
    public static string DescribeAspectRatio(int width, int height)
    {
        var divisor = GreatestCommonDivisor(width, height);
        // 仅兼容没有声明比例的旧记录；新快照、任务与文章直接保留模型声明值。
        var standard = new (int Width, int Height)[]
        {
            (1, 1), (2, 3), (3, 2), (3, 4), (4, 3),
            (4, 5), (5, 4), (9, 16), (16, 9), (21, 9),
        };
        var ratio = width / (double)height;
        var closest = standard.Select(x => (x.Width, x.Height,
                Difference: Math.Abs(ratio / (x.Width / (double)x.Height) - 1)))
            .OrderBy(x => x.Difference).First();
        return closest.Difference <= 0.02 ? $"{closest.Width}:{closest.Height}" : $"{width / divisor}:{height / divisor}";
    }

    private static int GreatestCommonDivisor(int left, int right)
    {
        while (right != 0) (left, right) = (right, left % right);
        return left == 0 ? 1 : left;
    }

    public static ImageGenAdapterInfo? Describe(GatewayModelResolution resolution)
    {
        var info = ImageGenModelAdapterRegistry.GetAdapterInfo(resolution.ActualModel ?? string.Empty);
        var sizeControl = ImageSizeControlCapabilities.Parse(resolution.ParameterCapabilities);
        if (info?.Matched != true)
        {
            if (!sizeControl.IsConfigured) return null;
            info = new ImageGenAdapterInfo
            {
                Matched = true,
                SizeConstraintType = "upstream",
                SizeConstraintDescription = "由网关模型能力控制",
            };
        }
        return ApplySizeControl(info, resolution.ParameterCapabilities);
    }

    private static ImageGenAdapterInfo ApplySizeControl(ImageGenAdapterInfo info, IReadOnlyDictionary<string, bool>? capabilities)
    {
        var sizeControl = ImageSizeControlCapabilities.Parse(capabilities);
        if (sizeControl.IsConfigured)
        {
            info.SizeParamFormat = sizeControl.FieldFormat switch
            {
                ImageSizeFieldFormats.Size => SizeParamFormats.WxH,
                ImageSizeFieldFormats.WidthHeight => SizeParamFormats.WidthHeight,
                ImageSizeFieldFormats.AspectRatio or ImageSizeFieldFormats.ImageConfigAspectRatio => SizeParamFormats.AspectRatio,
                _ => SizeParamFormats.None,
            };
            info.SizesNotApplicable = sizeControl.SizesNotApplicable;
            info.IsAdaptive = sizeControl.UsePrompt;
        }
        return info;
    }
}
