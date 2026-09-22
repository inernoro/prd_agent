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
        if (info.SizesNotApplicable || string.IsNullOrWhiteSpace(request.Size)) return null;
        var parts = request.Size.Split('x');
        if (parts.Length != 2 || !int.TryParse(parts[0], out var width) || !int.TryParse(parts[1], out var height)
            || width <= 0 || height <= 0) return "图片尺寸格式不正确，请重新选择尺寸。";
        if (info.SizeConstraintType == SizeConstraintTypes.Whitelist
            && !info.SizesByResolution.Values.SelectMany(x => x).Any(x => x.Size == request.Size))
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
            item.ImageCapabilities is not null);
        var snapshot = member?.ImageCapabilities;
        if (snapshot is null) return null;

        var sizes = new Dictionary<string, List<SizeOption>>(StringComparer.OrdinalIgnoreCase);
        foreach (var (bucket, rawSizes) in snapshot.SizesByResolution)
        {
            sizes[bucket] = rawSizes
                .Select(ParseSizeOption)
                .Where(option => option is not null)
                .Cast<SizeOption>()
                .DistinctBy(option => option.Size, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        return new ImageGenAdapterInfo
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
    }

    private static SizeOption? ParseSizeOption(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var parts = raw.Trim().Split(['x', 'X', '×', '*'], StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 2
            || !int.TryParse(parts[0].Trim(), out var width)
            || !int.TryParse(parts[1].Trim(), out var height)
            || width <= 0 || height <= 0) return null;
        var divisor = GreatestCommonDivisor(width, height);
        return new SizeOption($"{width}x{height}", $"{width / divisor}:{height / divisor}");
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
