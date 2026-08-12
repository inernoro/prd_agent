using PrdAgent.Infrastructure.LLM.Adapters;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// 生图请求构建器 —— "模型配置 → 上游请求体" 转换的唯一收口点。
///
/// 历史背景：在引入本类之前，"把一份生图请求适配成某个模型/平台能接受的上游请求体"
/// 这件事散落在三处：
///   1. <see cref="ImageGenModelAdapterRegistry"/>（尺寸归一化 + 尺寸参数格式 + 参数重命名）
///   2. 各平台 <c>IImageGenPlatformAdapter</c>（最终请求体形状的拼装）
///   3. <see cref="OpenAIImageClient"/>（在发送前临时组装 size/normalizedSize/sizeParams 再调适配器）
/// 导致"加一个新生图模型"经常要同时改尺寸归一化、参数注入、请求体拼装多处。
///
/// 本类把上述"标准 OpenAI 兼容 / Volces 协议"的转换收拢到一个方法里，
/// 让调用方（OpenAIImageClient 退化为纯发送器）只需要：
///   var built = ImageGenRequestBuilder.BuildStandardGeneration(model, prompt, n, requestedSize, responseFormat, platformAdapter);
///   // built.RequestBody 即可直接发上游
///
/// 加一个新生图模型的成本目标：
///   - 尺寸怎么传给上游由 llmgw 模型能力显式声明；旧模型才按名称回退到
///     <see cref="ImageGenModelConfigs"/> 的 SizeParamFormat / InjectSizePrompt。
///   - 模型支持哪些尺寸与归一化限制仍在 <see cref="ImageGenModelConfigs"/> 维护，
///     直到上游能力契约覆盖这组约束。
///   - 仅当上游协议形状全新（既非 OpenAI 兼容、又非 Volces/Google/OpenRouter/即梦 Exchange 之一）时，
///     才需要再新增一个 <c>IImageGenPlatformAdapter</c> 实现并在
///     <see cref="ImageGenPlatformAdapterFactory"/> 注册。
///
/// 说明：Exchange（即梦统一 JSON）/ Google generateContent / OpenRouter chat+modalities
/// 这三类是"上游协议本身不同"，请求体结构与标准 images/generations 完全不同，
/// 它们仍由 <see cref="GooglePlatformAdapter"/> 等专属适配器/分支构建——本类不强行统一，
/// 否则会把"协议差异"和"参数格式差异"两件事混进一个泥球。本类只统一"标准协议下的参数转换"。
///
/// 遵循 compute-then-send（见 .claude/rules/compute-then-send.md）：本类纯计算，不发 HTTP、不查 DB。
/// </summary>
public static class ImageGenRequestBuilder
{
    private const string AdaptiveSizePromptMarker = "[输出尺寸要求 / OUTPUT SIZE，最高优先级]";

    /// <summary>
    /// 把结构化尺寸转换成特殊模型可理解的置顶语言指令。
    /// 默认作用于“自适应 + 不发送尺寸参数 + 尺寸仍适用”的模型；配置明确开启
    /// InjectSizePrompt 时，会在保留原生尺寸参数的同时增加语义兜底。
    /// SizesNotApplicable 模型完全不参与尺寸选择和提示词注入。
    /// </summary>
    public static string ApplyAdaptiveSizePrompt(
        string prompt,
        ImageGenRequestParams requestParams,
        ImageGenModelAdapterConfig? adapterConfig)
    {
        if (adapterConfig == null
            || (!requestParams.IsAdaptive && !adapterConfig.InjectSizePrompt)
            || (requestParams.IsAdaptive && adapterConfig.SizeParamFormat != SizeParamFormats.None)
            || adapterConfig.SizesNotApplicable)
        {
            return prompt;
        }

        var adaptation = requestParams.Adaptation;
        if (adaptation.Width <= 0 || adaptation.Height <= 0 || string.IsNullOrWhiteSpace(adaptation.Size))
        {
            return prompt;
        }

        var safePrompt = prompt ?? string.Empty;
        var trimmedPrompt = safePrompt.TrimStart();
        if (trimmedPrompt.StartsWith(AdaptiveSizePromptMarker, StringComparison.Ordinal))
        {
            return safePrompt;
        }

        var ratio = string.IsNullOrWhiteSpace(adaptation.AspectRatio)
            ? ReduceRatio(adaptation.Width, adaptation.Height)
            : adaptation.AspectRatio;
        var orientation = adaptation.Width == adaptation.Height
            ? "正方形 / square"
            : adaptation.Width > adaptation.Height
                ? "横版 / landscape"
                : "竖版 / portrait";
        var exclusion = adaptation.Width == adaptation.Height
            ? "不要改变画幅。"
            : "不要输出正方形或其他比例。";
        var directive = $"{AdaptiveSizePromptMarker} 目标画布 {adaptation.Size}，严格宽高比 {ratio}，{orientation}。{exclusion}";
        return string.IsNullOrWhiteSpace(safePrompt) ? directive : $"{directive}\n{safePrompt}";
    }

    /// <summary>
    /// 按上游模型能力显式注入尺寸提示词。与静态适配表无关，用于 Gateway 已解析出实际模型后
    /// 消费 llmgw_models 上的 image_size.prompt 能力。
    /// </summary>
    public static string ApplyConfiguredSizePrompt(string prompt, string? requestedSize)
    {
        var normalized = string.IsNullOrWhiteSpace(requestedSize) ? "1024x1024" : requestedSize.Trim();
        var parts = normalized.Split(new[] { 'x', 'X' }, StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 2
            || !int.TryParse(parts[0], out var width)
            || !int.TryParse(parts[1], out var height)
            || width <= 0
            || height <= 0)
        {
            return prompt;
        }

        var requestParams = new ImageGenRequestParams
        {
            IsAdaptive = true,
            Adaptation = new SizeAdaptationResult
            {
                Size = $"{width}x{height}",
                Width = width,
                Height = height,
                AspectRatio = ReduceRatio(width, height),
            },
        };
        var configuredAdapter = new ImageGenModelAdapterConfig
        {
            SizeConstraintType = SizeConstraintTypes.Adaptive,
            SizeParamFormat = SizeParamFormats.None,
            InjectSizePrompt = true,
        };
        return ApplyAdaptiveSizePrompt(prompt, requestParams, configuredAdapter);
    }

    /// <summary>移除由尺寸适配器写入首行的受控尺寸指令，保留原始业务提示词。</summary>
    public static string RemoveSizePromptDirective(string prompt)
    {
        var safePrompt = prompt ?? string.Empty;
        var trimmedPrompt = safePrompt.TrimStart();
        if (!trimmedPrompt.StartsWith(AdaptiveSizePromptMarker, StringComparison.Ordinal))
            return safePrompt;
        var lineBreak = trimmedPrompt.IndexOf('\n');
        return lineBreak < 0 ? string.Empty : trimmedPrompt[(lineBreak + 1)..];
    }

    /// <summary>
    /// 构建"标准 OpenAI 兼容 / Volces"协议下的文生图上游请求体。
    /// 一次性完成：尺寸归一化 → 尺寸参数格式（size / width+height / aspect_ratio / none）→ 参数重命名 → 请求体拼装。
    /// </summary>
    /// <param name="model">实际模型名（已解析，不再二次 resolve）</param>
    /// <param name="prompt">提示词</param>
    /// <param name="n">生成数量</param>
    /// <param name="requestedSize">请求尺寸（WxH 格式，可空；自适应模型会被忽略）</param>
    /// <param name="responseFormat">响应格式（url / b64_json，可空）。若模型配置 SupportsResponseFormat=false 会被剔除。</param>
    /// <param name="platformAdapter">平台适配器（决定最终请求体形状，如 OpenAI 兼容 / Volces）</param>
    /// <returns>构建结果（含请求体 + 尺寸适配元信息 + 命中的适配器配置）</returns>
    public static BuiltImageGenRequest BuildStandardGeneration(
        string model,
        string prompt,
        int n,
        string? requestedSize,
        string? responseFormat,
        IImageGenPlatformAdapter platformAdapter,
        bool applyAdaptiveSizePrompt = true)
    {
        // 1. 尺寸归一化 + 尺寸参数格式 + 参数重命名（SSOT：Registry）
        var reqParams = ImageGenModelAdapterRegistry.BuildRequestParams(
            modelName: model,
            requestedSize: requestedSize);

        var adapterConfig = reqParams.HasAdapter
            ? ImageGenModelAdapterRegistry.TryMatch(model)
            : null;

        var isAdaptive = reqParams.HasAdapter && reqParams.IsAdaptive;

        // 2. 模型配置声明不支持 response_format（如 apiyi 的 gpt-image-1.5 / gpt-image-2-all）→ 剔除
        var effectiveResponseFormat = responseFormat;
        if (platformAdapter.ForceUrlResponseFormat)
            effectiveResponseFormat = "url";
        if (adapterConfig?.SupportsResponseFormat == false)
            effectiveResponseFormat = null;

        // 3. 已归一化的 size 参数（可能是 size / width+height / aspect_ratio，已应用 ParamRenames）。
        //    自适应模型（SizeParamFormat=none）下 reqParams.SizeParams 为空，下游不注入任何尺寸字段。
        var sizeParams = reqParams.HasAdapter && reqParams.SizeParams.Count > 0
            ? reqParams.SizeParams
            : null;

        // 4. 计算"用于 size 字段的字符串"（仅在无适配器 size 参数时由平台适配器 NormalizeSize 兜底）。
        //    自适应模型显式置空，避免被注入到请求体。
        var sizeForBody = isAdaptive ? null : NormalizedSizeForBody(reqParams, requestedSize);
        var normalizedSize = platformAdapter.NormalizeSize(sizeForBody);
        var effectivePrompt = applyAdaptiveSizePrompt
            ? ApplyAdaptiveSizePrompt(prompt, reqParams, adapterConfig)
            : prompt;

        // 5. 由平台适配器拼装最终请求体（OpenAI 兼容 / Volces 等）
        var requestBody = platformAdapter.BuildGenerationRequest(
            model,
            effectivePrompt,
            n,
            normalizedSize,
            effectiveResponseFormat,
            sizeParams);

        return new BuiltImageGenRequest
        {
            RequestBody = requestBody,
            Adaptation = reqParams.Adaptation,
            AdapterConfig = adapterConfig,
            IsAdaptive = isAdaptive,
            HasAdapter = reqParams.HasAdapter,
            EffectiveResponseFormat = effectiveResponseFormat,
        };
    }

    /// <summary>
    /// 仅做"最终请求体拼装"的收口（不重新归一化尺寸）。
    /// 给已经完成尺寸编排（含 caps 白名单兜底、自适应置空等）的调用方使用：
    /// 把"reqParams → sizeParams 注入 → 平台适配器拼装"这一步统一到此，避免散在调用方内联。
    /// </summary>
    /// <param name="model">实际模型名</param>
    /// <param name="prompt">提示词</param>
    /// <param name="n">生成数量</param>
    /// <param name="reqParams">已由 <see cref="ImageGenModelAdapterRegistry.BuildRequestParams"/> 算好的参数（含 SizeParams / 是否自适应）</param>
    /// <param name="normalizedSize">调用方编排后的最终 size 字符串（无适配器尺寸参数时由平台 NormalizeSize 兜底）</param>
    /// <param name="effectiveResponseFormat">已剔除/归一化后的 response_format</param>
    /// <param name="platformAdapter">平台适配器</param>
    /// <returns>上游请求体（Dictionary 或强类型对象）</returns>
    public static object BuildGenerationBody(
        string model,
        string prompt,
        int n,
        ImageGenRequestParams reqParams,
        string? normalizedSize,
        string? effectiveResponseFormat,
        IImageGenPlatformAdapter platformAdapter)
    {
        var sizeParams = reqParams.HasAdapter && reqParams.SizeParams.Count > 0
            ? reqParams.SizeParams
            : null;
        var adapterConfig = reqParams.HasAdapter ? ImageGenModelAdapterRegistry.TryMatch(model) : null;
        var effectivePrompt = ApplyAdaptiveSizePrompt(prompt, reqParams, adapterConfig);

        return platformAdapter.BuildGenerationRequest(
            model,
            effectivePrompt,
            n,
            normalizedSize,
            effectiveResponseFormat,
            sizeParams);
    }

    /// <summary>
    /// 计算最终落到请求体 size 字段的字符串：
    /// - 有适配器：用归一化后的 Adaptation.Size（与 sizeParams 一致），非自适应才有值。
    /// - 无适配器：用调用方原始 requestedSize（保持旧行为，由 BuildRequestParams 已填默认）。
    /// </summary>
    private static string? NormalizedSizeForBody(ImageGenRequestParams reqParams, string? requestedSize)
    {
        if (reqParams.HasAdapter)
        {
            // 自适应：Adaptation.Size 为空字符串，返回 null
            return string.IsNullOrWhiteSpace(reqParams.Adaptation.Size) ? null : reqParams.Adaptation.Size;
        }
        return string.IsNullOrWhiteSpace(requestedSize) ? null : requestedSize.Trim();
    }

    private static string ReduceRatio(int width, int height)
    {
        var a = Math.Abs(width);
        var b = Math.Abs(height);
        while (b != 0)
        {
            (a, b) = (b, a % b);
        }

        var divisor = Math.Max(1, a);
        return $"{width / divisor}:{height / divisor}";
    }

    /// <summary>
    /// 从像素尺寸推导 OpenRouter image_config.aspect_ratio 支持的最接近比例。
    /// </summary>
    internal static string? DeriveOpenRouterAspectRatio(string? size)
    {
        if (!ImageGenModelAdapterRegistry.TryParseSize(size, out var width, out var height)
            || width <= 0
            || height <= 0)
        {
            return null;
        }

        var target = (double)width / height;
        var candidates = new (string Label, double Ratio)[]
        {
            ("1:1", 1.0), ("2:3", 2.0 / 3), ("3:2", 3.0 / 2), ("3:4", 3.0 / 4), ("4:3", 4.0 / 3),
            ("4:5", 4.0 / 5), ("5:4", 5.0 / 4), ("9:16", 9.0 / 16), ("16:9", 16.0 / 9), ("21:9", 21.0 / 9),
        };
        return candidates.MinBy(candidate => Math.Abs(candidate.Ratio - target)).Label;
    }
}

/// <summary>
/// 生图请求构建结果（纯数据，供发送阶段直接使用）。
/// </summary>
public sealed class BuiltImageGenRequest
{
    /// <summary>已拼装好的上游请求体（Dictionary 或强类型对象，由平台适配器决定）。</summary>
    public required object RequestBody { get; init; }

    /// <summary>尺寸适配元信息（SizeAdjusted / RatioAdjusted / Resolution 等，供日志与 meta 展示）。</summary>
    public SizeAdaptationResult Adaptation { get; init; } = new();

    /// <summary>命中的模型适配器配置（未命中为 null）。</summary>
    public ImageGenModelAdapterConfig? AdapterConfig { get; init; }

    /// <summary>是否为自适应模型（请求体不含任何尺寸字段，尺寸由 prompt 决定）。</summary>
    public bool IsAdaptive { get; init; }

    /// <summary>是否命中了模型适配器配置。</summary>
    public bool HasAdapter { get; init; }

    /// <summary>最终实际使用的 response_format（可能被剔除为 null）。</summary>
    public string? EffectiveResponseFormat { get; init; }
}
