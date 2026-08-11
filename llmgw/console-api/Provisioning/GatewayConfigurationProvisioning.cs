using System.Net;
using MongoDB.Bson;
using PrdAgent.LlmGw.ModelPools;
using PrdAgent.LlmGw.Models;

namespace PrdAgent.LlmGw.Provisioning;

public sealed record NormalizedPlatformDraft(
    string Name,
    string NameNormalized,
    string PlatformType,
    string? ProviderId,
    string ApiUrl,
    string ApiKey,
    int MaxConcurrency,
    string? Remark);

public sealed record NormalizedModelDraft(
    string PlatformId,
    string Name,
    string ModelName,
    string ModelNameNormalized,
    string? Protocol,
    IReadOnlyList<string> Capabilities,
    string ImageSizeControlMode,
    string? ImageSizeFieldFormat,
    string? ApiKey,
    int Timeout,
    int MaxRetries,
    int MaxConcurrency,
    int? MaxTokens,
    decimal? InputPricePerMillion,
    decimal? OutputPricePerMillion,
    decimal? PricePerCall,
    string? PriceCurrency,
    string? Remark);

public sealed record NormalizedExchangeModelDraft(
    string ModelId,
    string? DisplayName,
    string ModelType,
    string? Description,
    bool Enabled);

public sealed record NormalizedExchangeDraft(
    string Name,
    string NameNormalized,
    IReadOnlyList<NormalizedExchangeModelDraft> Models,
    string TargetUrl,
    string? ApiKey,
    string TargetAuthScheme,
    string TransformerType,
    bool Enabled,
    string? Description,
    long? Version);

public static class GatewayConfigurationProvisioning
{
    private const string ImageSizeParameterPrefix = "image_size.";
    private static readonly string[] ParameterCapabilityPrefixes =
        ["parameter:", "parameter.", "param:", "param."];
    private static readonly HashSet<string> SupportedImageSizeControlModes =
    [
        "inherit", "field", "prompt", "field_and_prompt", "none",
    ];
    private static readonly HashSet<string> SupportedImageSizeFieldFormats =
    [
        "size", "width_height", "aspect_ratio", "image_config.aspect_ratio",
    ];
    private static readonly HashSet<string> SupportedModelTypes =
    [
        "chat", "intent", "vision", "generation", "code", "long-context", "embedding",
        "rerank", "asr", "tts", "video-gen", "audio-gen", "moderation",
    ];
    private static readonly IReadOnlyDictionary<string, string> ExchangeAuthSchemes =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["bearer"] = "Bearer",
            ["key"] = "Key",
            ["xapikey"] = "XApiKey",
            ["x-api-key"] = "XApiKey",
            ["x-goog-api-key"] = "x-goog-api-key",
        };
    private static readonly HashSet<string> ExchangeTransformerTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "passthrough",
        "fal-image",
        "fal-image-edit",
        "fal-image-layered",
        "doubao-asr",
        "doubao-asr-stream",
        "volcengine-video",
        "gemini-native",
    };

    public static IReadOnlyList<ExchangeOptionItem> GetExchangeTransformerOptions() =>
    [
        new() { Value = "passthrough", Label = "直接转发", Description = "上游已经接近目标请求格式" },
        new() { Value = "gemini-native", Label = "Gemini 原生", Description = "转换 Gemini 原生请求与响应" },
        new() { Value = "fal-image", Label = "fal.ai 图片", Description = "适配 fal.ai 图片生成与编辑" },
        new() { Value = "fal-image-layered", Label = "fal.ai 图片分层", Description = "适配 Qwen-Image-Layered RGBA 图层分解" },
        new() { Value = "doubao-asr", Label = "豆包语音识别", Description = "适配豆包异步语音识别" },
        new() { Value = "doubao-asr-stream", Label = "豆包流式语音识别", Description = "适配豆包 WebSocket 流式语音识别" },
        new() { Value = "volcengine-video", Label = "火山视频生成", Description = "适配火山方舟视频任务协议" },
    ];

    public static IReadOnlyList<ExchangeOptionItem> GetExchangeAuthSchemeOptions() =>
    [
        new() { Value = "Bearer", Label = "Bearer", Description = "Authorization: Bearer" },
        new() { Value = "Key", Label = "Key", Description = "Authorization: Key" },
        new() { Value = "XApiKey", Label = "x-api-key", Description = "x-api-key 请求头" },
        new() { Value = "x-goog-api-key", Label = "Google API Key", Description = "x-goog-api-key 请求头" },
    ];

    public static IReadOnlyList<ExchangeOptionItem> GetExchangeModelTypeOptions() =>
        GatewayModelPoolTypeRegistry.All
            .Select(item => new ExchangeOptionItem { Value = item.Code, Label = item.Name, Description = item.Purpose })
            .ToList();

    public static bool TryNormalizePlatform(
        CreatePlatformRequest? request,
        out NormalizedPlatformDraft? draft,
        out string error)
    {
        draft = null;
        error = string.Empty;
        if (request is null) return Fail("请求体不能为空", out error);

        var name = request.Name?.Trim() ?? string.Empty;
        if (name.Length == 0) return Fail("Provider 名称不能为空", out error);
        if (name.Length > 120) return Fail("Provider 名称不能超过 120 个字符", out error);

        var platformType = NormalizePlatformType(request.PlatformType);
        if (platformType is null) return Fail("Provider 类型只支持 OpenAI 兼容或 Claude 兼容", out error);

        var apiUrl = request.ApiUrl?.Trim() ?? string.Empty;
        if (!TryNormalizeHttpUrl(apiUrl, out var normalizedUrl))
            return Fail("API 地址必须是完整的 http 或 https 地址，且不能包含用户名或密码", out error);

        var apiKey = request.ApiKey?.Trim() ?? string.Empty;
        if (apiKey.Length == 0) return Fail("Provider 通讯密钥不能为空", out error);
        if (apiKey.Length > 20000) return Fail("Provider 通讯密钥长度超出限制", out error);

        var maxConcurrency = request.MaxConcurrency ?? 20;
        if (maxConcurrency is < 1 or > 10000) return Fail("最大并发必须在 1 到 10000 之间", out error);

        var providerId = TrimToNull(request.ProviderId, 160, "Provider 标识", out error);
        if (error.Length > 0) return false;
        var remark = TrimToNull(request.Remark, 1000, "备注", out error);
        if (error.Length > 0) return false;

        draft = new NormalizedPlatformDraft(
            name,
            name.ToLowerInvariant(),
            platformType,
            providerId,
            normalizedUrl,
            apiKey,
            maxConcurrency,
            remark);
        return true;
    }

    public static bool TryNormalizeModel(
        CreateModelRequest? request,
        out NormalizedModelDraft? draft,
        out string error)
    {
        draft = null;
        error = string.Empty;
        if (request is null) return Fail("请求体不能为空", out error);

        var platformId = request.PlatformId?.Trim() ?? string.Empty;
        if (platformId.Length == 0) return Fail("请先选择 Provider", out error);
        if (platformId.Length > 200) return Fail("Provider 标识长度超出限制", out error);

        var modelName = request.ModelName?.Trim() ?? string.Empty;
        if (modelName.Length == 0) return Fail("上游模型标识不能为空", out error);
        if (modelName.Length > 240) return Fail("上游模型标识不能超过 240 个字符", out error);
        var name = request.Name?.Trim() ?? modelName;
        if (name.Length > 160) return Fail("模型显示名称不能超过 160 个字符", out error);

        var requestedProtocol = request.Protocol?.Trim();
        var protocol = NormalizeProtocol(requestedProtocol);
        if (!string.IsNullOrWhiteSpace(requestedProtocol)
            && !string.Equals(requestedProtocol, "inherit", StringComparison.OrdinalIgnoreCase)
            && protocol is null)
            return Fail("协议只支持继承 Provider、OpenAI 或 Claude", out error);

        var requestedCapabilities = request.Capabilities ?? new List<string>();
        var modelTypes = requestedCapabilities
            .Select(x => x?.Trim().ToLowerInvariant() ?? string.Empty)
            .Where(x => x.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (modelTypes.Count == 0) return Fail("请至少选择一种模型用途", out error);
        if (modelTypes.Any(x => !SupportedModelTypes.Contains(x)))
            return Fail("模型用途包含不支持的类型", out error);

        var imageSizeControlMode = request.ImageSizeControlMode?.Trim().ToLowerInvariant() ?? "inherit";
        var imageSizeFieldFormat = request.ImageSizeFieldFormat?.Trim().ToLowerInvariant();
        if (!SupportedImageSizeControlModes.Contains(imageSizeControlMode))
            return Fail("图片尺寸控制方式不支持", out error);
        var usesSizeField = imageSizeControlMode is "field" or "field_and_prompt";
        if (usesSizeField && (imageSizeFieldFormat is null || !SupportedImageSizeFieldFormats.Contains(imageSizeFieldFormat)))
            return Fail("字段控制尺寸时必须选择受支持的字段格式", out error);
        if (!usesSizeField && !string.IsNullOrWhiteSpace(imageSizeFieldFormat))
            return Fail("当前尺寸控制方式不应填写字段格式", out error);
        if (imageSizeControlMode != "inherit" && !modelTypes.Contains("generation", StringComparer.OrdinalIgnoreCase))
            return Fail("只有图片生成模型可以配置图片尺寸控制能力", out error);

        var apiKey = request.ApiKey?.Trim();
        if (apiKey?.Length > 20000) return Fail("模型通讯密钥长度超出限制", out error);
        if (apiKey?.Length == 0) apiKey = null;

        var timeout = request.Timeout ?? 120;
        if (timeout is < 1 or > 3600) return Fail("超时时间必须在 1 到 3600 秒之间", out error);
        var maxRetries = request.MaxRetries ?? 2;
        if (maxRetries is < 0 or > 10) return Fail("重试次数必须在 0 到 10 之间", out error);
        var maxConcurrency = request.MaxConcurrency ?? 0;
        if (maxConcurrency is < 0 or > 10000) return Fail("最大并发必须在 0 到 10000 之间", out error);
        if (request.MaxTokens is < 1 or > 10000000) return Fail("最大 Token 数必须在 1 到 10000000 之间", out error);

        var prices = new[] { request.InputPricePerMillion, request.OutputPricePerMillion, request.PricePerCall };
        if (prices.Any(x => x is < 0)) return Fail("价格不能为负数", out error);
        var hasPrice = prices.Any(x => x is not null);
        var currency = request.PriceCurrency?.Trim().ToUpperInvariant();
        if (hasPrice && currency is not ("CNY" or "USD"))
            return Fail("填写价格时必须选择 CNY 或 USD", out error);
        if (!hasPrice && !string.IsNullOrWhiteSpace(currency))
            return Fail("没有填写价格时不要单独选择币种", out error);

        var remark = TrimToNull(request.Remark, 1000, "备注", out error);
        if (error.Length > 0) return false;

        draft = new NormalizedModelDraft(
            platformId,
            name,
            modelName,
            modelName.ToLowerInvariant(),
            protocol,
            modelTypes,
            imageSizeControlMode,
            usesSizeField ? imageSizeFieldFormat : null,
            apiKey,
            timeout,
            maxRetries,
            maxConcurrency,
            request.MaxTokens,
            request.InputPricePerMillion,
            request.OutputPricePerMillion,
            request.PricePerCall,
            hasPrice ? currency : null,
            remark);
        return true;
    }

    public static bool TryNormalizeExchange(
        CreateExchangeRequest? request,
        out NormalizedExchangeDraft? draft,
        out string error)
    {
        if (request is null)
        {
            draft = null;
            return Fail("请求体不能为空", out error);
        }
        return TryNormalizeExchangeCore(
            request.Name,
            request.Models,
            request.TargetUrl,
            request.ApiKey,
            request.TargetAuthScheme,
            request.TransformerType,
            request.Enabled,
            request.Description,
            version: null,
            requireApiKey: true,
            out draft,
            out error);
    }

    public static bool TryNormalizeExchange(
        UpdateExchangeRequest? request,
        out NormalizedExchangeDraft? draft,
        out string error)
    {
        if (request is null)
        {
            draft = null;
            return Fail("请求体不能为空", out error);
        }
        if (request.Version is null or < 0)
        {
            draft = null;
            return Fail("缺少有效的 version，无法防止覆盖他人的修改", out error);
        }
        return TryNormalizeExchangeCore(
            request.Name,
            request.Models,
            request.TargetUrl,
            apiKey: null,
            request.TargetAuthScheme,
            request.TransformerType,
            request.Enabled,
            request.Description,
            request.Version,
            requireApiKey: false,
            out draft,
            out error);
    }

    public static BsonDocument BuildExchangeDocument(
        NormalizedExchangeDraft draft,
        string tenantId,
        string id,
        string encryptedApiKey,
        DateTime now) => new()
    {
        ["_id"] = id,
        ["TenantId"] = tenantId,
        ["Name"] = draft.Name,
        ["NameNormalized"] = draft.NameNormalized,
        ["Models"] = BuildExchangeModels(draft.Models),
        ["TargetUrl"] = draft.TargetUrl,
        ["TargetApiKeyEncrypted"] = encryptedApiKey,
        ["TargetAuthScheme"] = draft.TargetAuthScheme,
        ["TransformerType"] = draft.TransformerType,
        ["Enabled"] = draft.Enabled,
        ["Description"] = ToBsonValue(draft.Description),
        ["Authority"] = "llm_gateway",
        ["SourceCollection"] = "llmgw_model_exchanges",
        ["ClaimedAt"] = now,
        ["CreatedAt"] = now,
        ["UpdatedAt"] = now,
        ["Version"] = 1L,
    };

    public static BsonArray BuildExchangeModels(IReadOnlyList<NormalizedExchangeModelDraft> models) =>
        new(models.Select(model => new BsonDocument
        {
            ["ModelId"] = model.ModelId,
            ["DisplayName"] = ToBsonValue(model.DisplayName),
            ["ModelType"] = model.ModelType,
            ["Description"] = ToBsonValue(model.Description),
            ["Enabled"] = model.Enabled,
        }));

    public static BsonDocument BuildExchangePoolModelDocument(string exchangeId, BsonDocument exchangeModel)
    {
        var modelId = exchangeModel.GetValue("ModelId", string.Empty).AsString;
        var modelType = exchangeModel.GetValue("ModelType", "chat").AsString.Trim().ToLowerInvariant();
        return new BsonDocument
        {
            ["_id"] = $"{exchangeId}:{modelId}",
            ["PlatformId"] = exchangeId,
            ["Name"] = exchangeModel.TryGetValue("DisplayName", out var displayName) && displayName.IsString
                ? displayName.AsString
                : modelId,
            ["ModelName"] = modelId,
            ["Enabled"] = exchangeModel.TryGetValue("Enabled", out var enabled) ? enabled : true,
            ["IsMain"] = modelType == "chat",
            ["IsIntent"] = modelType == "intent",
            ["IsVision"] = modelType == "vision",
            ["IsImageGen"] = modelType == "generation",
            ["Capabilities"] = new BsonArray([ToCapabilityDocument(modelType)]),
            ["Authority"] = "llm_gateway",
            ["SourceCollection"] = "llmgw_model_exchanges",
        };
    }

    public static BsonDocument BuildPlatformDocument(
        NormalizedPlatformDraft draft,
        string tenantId,
        string id,
        string encryptedApiKey,
        DateTime now) => new()
    {
        ["_id"] = id,
        ["TenantId"] = tenantId,
        ["Name"] = draft.Name,
        ["NameNormalized"] = draft.NameNormalized,
        ["PlatformType"] = draft.PlatformType,
        ["ProviderId"] = ToBsonValue(draft.ProviderId),
        ["ApiUrl"] = draft.ApiUrl,
        ["ApiKeyEncrypted"] = encryptedApiKey,
        ["MaxConcurrency"] = draft.MaxConcurrency,
        ["Remark"] = ToBsonValue(draft.Remark),
        ["Enabled"] = true,
        ["Authority"] = "llm_gateway",
        ["SourceCollection"] = "llmgw_platforms",
        ["CreatedAt"] = now,
        ["UpdatedAt"] = now,
    };

    public static BsonDocument BuildModelDocument(
        NormalizedModelDraft draft,
        string tenantId,
        string id,
        string? encryptedApiKey,
        DateTime now)
    {
        var capabilityDocuments = draft.Capabilities.Select(ToCapabilityDocument).ToList();
        capabilityDocuments.AddRange(BuildImageSizeCapabilityDocuments(draft.ImageSizeControlMode, draft.ImageSizeFieldFormat));
        var document = new BsonDocument
        {
            ["_id"] = id,
            ["TenantId"] = tenantId,
            ["PlatformId"] = draft.PlatformId,
            ["Name"] = draft.Name,
            ["ModelName"] = draft.ModelName,
            ["ModelNameNormalized"] = draft.ModelNameNormalized,
            ["Protocol"] = ToBsonValue(draft.Protocol),
            ["Timeout"] = draft.Timeout,
            ["MaxRetries"] = draft.MaxRetries,
            ["MaxConcurrency"] = draft.MaxConcurrency,
            ["MaxTokens"] = ToBsonValue(draft.MaxTokens),
            ["InputPricePerMillion"] = ToBsonValue(draft.InputPricePerMillion),
            ["OutputPricePerMillion"] = ToBsonValue(draft.OutputPricePerMillion),
            ["PricePerCall"] = ToBsonValue(draft.PricePerCall),
            ["PriceCurrency"] = ToBsonValue(draft.PriceCurrency),
            ["Remark"] = ToBsonValue(draft.Remark),
            ["Enabled"] = true,
            ["Priority"] = 100,
            ["IsMain"] = false,
            ["IsIntent"] = draft.Capabilities.Contains("intent", StringComparer.OrdinalIgnoreCase),
            ["IsVision"] = draft.Capabilities.Contains("vision", StringComparer.OrdinalIgnoreCase),
            ["IsImageGen"] = draft.Capabilities.Contains("generation", StringComparer.OrdinalIgnoreCase),
            ["Capabilities"] = new BsonArray(capabilityDocuments),
            ["Authority"] = "llm_gateway",
            ["SourceCollection"] = "llmgw_models",
            ["CreatedAt"] = now,
            ["UpdatedAt"] = now,
        };
        if (!string.IsNullOrWhiteSpace(encryptedApiKey)) document["ApiKeyEncrypted"] = encryptedApiKey;
        return document;
    }

    private static BsonDocument ToCapabilityDocument(string modelType)
    {
        var capability = modelType switch
        {
            "generation" => "image_generation",
            "long-context" => "long_context",
            "video-gen" => "video_generation",
            "audio-gen" => "audio_generation",
            _ => modelType,
        };
        return new BsonDocument { ["Type"] = capability, ["Source"] = "user", ["Value"] = true };
    }

    public static bool IsImageSizeControlCapability(string? type)
        => NormalizeParameterCapabilityName(type)?
            .StartsWith(ImageSizeParameterPrefix, StringComparison.OrdinalIgnoreCase) == true;

    public static string? NormalizeParameterCapabilityName(string? type)
    {
        if (string.IsNullOrWhiteSpace(type)) return null;
        var normalized = type.Trim();
        foreach (var prefix in ParameterCapabilityPrefixes)
        {
            if (!normalized.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
            var name = normalized[prefix.Length..].Trim();
            return name.Length == 0 ? null : name;
        }
        return null;
    }

    public static bool TryNormalizeBulkCapabilityType(
        string? rawType,
        out string type,
        out string error)
    {
        type = rawType?.Trim() ?? string.Empty;
        error = string.Empty;
        if (type.Length == 0) return Fail("capability.type 不能为空", out error);
        if (type.Length > 120) return Fail("capability.type 长度超出限制", out error);
        if (IsImageSizeControlCapability(type))
            return Fail("图片尺寸控制能力必须通过专用接口维护", out error);
        return true;
    }

    public static IReadOnlyList<BsonDocument> BuildImageSizeCapabilityDocuments(string mode, string? fieldFormat)
    {
        var types = new List<string>();
        if (mode == "none") types.Add("parameter:image_size.none");
        if (mode is "prompt" or "field_and_prompt") types.Add("parameter:image_size.prompt");
        if (mode is "field" or "field_and_prompt")
        {
            types.Add(fieldFormat switch
            {
                "size" => "parameter:image_size.field.size",
                "width_height" => "parameter:image_size.field.width_height",
                "aspect_ratio" => "parameter:image_size.field.aspect_ratio",
                "image_config.aspect_ratio" => "parameter:image_size.field.image_config_aspect_ratio",
                _ => throw new ArgumentOutOfRangeException(nameof(fieldFormat), fieldFormat, "不支持的生图尺寸字段格式"),
            });
        }
        return types.Select(type => new BsonDocument
        {
            ["Type"] = type,
            ["Source"] = "user",
            ["Value"] = true,
        }).ToList();
    }

    public static (string Mode, string? FieldFormat) MapImageSizeControl(
        IEnumerable<BsonDocument> capabilities)
    {
        var enabled = capabilities
            .Where(x => !x.TryGetValue("Value", out var value) || !value.IsBoolean || value.AsBoolean)
            .Select(x => NormalizeParameterCapabilityName(
                x.TryGetValue("Type", out var type) && type.IsString ? type.AsString : null))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (enabled.Contains("image_size.none")) return ("none", null);
        var usePrompt = enabled.Contains("image_size.prompt");
        var fieldFormat = enabled.Contains("image_size.field.image_config_aspect_ratio")
            ? "image_config.aspect_ratio"
            : enabled.Contains("image_size.field.aspect_ratio")
                ? "aspect_ratio"
                : enabled.Contains("image_size.field.width_height")
                    ? "width_height"
                    : enabled.Contains("image_size.field.size")
                        ? "size"
                        : null;
        return fieldFormat is null
            ? (usePrompt ? "prompt" : "inherit", null)
            : (usePrompt ? "field_and_prompt" : "field", fieldFormat);
    }

    public static bool TryNormalizeImageSizeControl(
        string? rawMode,
        string? rawFieldFormat,
        out string mode,
        out string? fieldFormat,
        out string error)
    {
        mode = rawMode?.Trim().ToLowerInvariant() ?? "inherit";
        fieldFormat = rawFieldFormat?.Trim().ToLowerInvariant();
        error = string.Empty;
        if (!SupportedImageSizeControlModes.Contains(mode))
            return Fail("图片尺寸控制方式不支持", out error);
        var usesSizeField = mode is "field" or "field_and_prompt";
        if (usesSizeField && (fieldFormat is null || !SupportedImageSizeFieldFormats.Contains(fieldFormat)))
            return Fail("字段控制尺寸时必须选择受支持的字段格式", out error);
        if (!usesSizeField && !string.IsNullOrWhiteSpace(fieldFormat))
            return Fail("当前尺寸控制方式不应填写字段格式", out error);
        if (!usesSizeField) fieldFormat = null;
        return true;
    }

    private static bool TryNormalizeExchangeCore(
        string? rawName,
        IReadOnlyList<ExchangeModelWriteRequest>? rawModels,
        string? rawTargetUrl,
        string? apiKey,
        string? rawAuthScheme,
        string? rawTransformerType,
        bool? enabled,
        string? rawDescription,
        long? version,
        bool requireApiKey,
        out NormalizedExchangeDraft? draft,
        out string error)
    {
        draft = null;
        error = string.Empty;
        var name = rawName?.Trim() ?? string.Empty;
        if (name.Length == 0) return Fail("Exchange 名称不能为空", out error);
        if (name.Length > 120) return Fail("Exchange 名称不能超过 120 个字符", out error);

        if (rawModels is null || rawModels.Count == 0)
            return Fail("请至少添加一个模型映射", out error);
        if (rawModels.Count > 50) return Fail("单个 Exchange 最多包含 50 个模型映射", out error);
        var models = new List<NormalizedExchangeModelDraft>();
        var modelIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in rawModels)
        {
            var modelId = item.ModelId?.Trim() ?? string.Empty;
            if (modelId.Length == 0) return Fail("模型标识不能为空", out error);
            if (modelId.Length > 240) return Fail("模型标识不能超过 240 个字符", out error);
            if (!modelIds.Add(modelId)) return Fail($"模型标识重复：{modelId}", out error);
            var modelType = item.ModelType?.Trim().ToLowerInvariant() ?? "chat";
            if (GatewayModelPoolTypeRegistry.Find(modelType) is null)
                return Fail($"不支持的模型用途：{modelType}", out error);
            var displayName = TrimToNull(item.DisplayName, 160, "模型显示名称", out error);
            if (error.Length > 0) return false;
            var modelDescription = TrimToNull(item.Description, 500, "模型说明", out error);
            if (error.Length > 0) return false;
            models.Add(new NormalizedExchangeModelDraft(modelId, displayName, modelType, modelDescription, item.Enabled ?? true));
        }

        var targetUrl = rawTargetUrl?.Trim() ?? string.Empty;
        if (!TryNormalizeExchangeUrl(targetUrl, out var normalizedUrl))
            return Fail("目标地址必须是完整的 http、https、ws 或 wss 地址，不能包含用户名、密码或密钥查询参数", out error);

        var normalizedApiKey = apiKey?.Trim();
        if (requireApiKey && string.IsNullOrWhiteSpace(normalizedApiKey))
            return Fail("Exchange 通讯密钥不能为空", out error);
        if (normalizedApiKey?.Length > 20000) return Fail("Exchange 通讯密钥长度超出限制", out error);

        var authInput = rawAuthScheme?.Trim() ?? "Bearer";
        if (!ExchangeAuthSchemes.TryGetValue(authInput, out var authScheme))
            return Fail("不支持的认证方式", out error);
        var transformerType = rawTransformerType?.Trim().ToLowerInvariant() ?? "passthrough";
        if (!ExchangeTransformerTypes.Contains(transformerType))
            return Fail($"未知的转换器类型：{transformerType}", out error);
        var description = TrimToNull(rawDescription, 1000, "Exchange 说明", out error);
        if (error.Length > 0) return false;

        draft = new NormalizedExchangeDraft(
            name,
            name.ToLowerInvariant(),
            models,
            normalizedUrl,
            string.IsNullOrWhiteSpace(normalizedApiKey) ? null : normalizedApiKey,
            authScheme,
            transformerType,
            enabled ?? true,
            description,
            version);
        return true;
    }

    private static string? NormalizePlatformType(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "openai" or "openrouter" or "openai-compatible" => "openai",
        "claude" or "anthropic" or "claude-compatible" => "claude",
        _ => null,
    };

    private static string? NormalizeProtocol(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        null or "" or "inherit" => null,
        "openai" or "openai-compatible" => "openai",
        "claude" or "anthropic" or "claude-compatible" => "claude",
        _ => null,
    };

    private static bool TryNormalizeHttpUrl(string value, out string normalized)
    {
        normalized = string.Empty;
        if (value.Length is 0 or > 2048
            || !Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || string.IsNullOrWhiteSpace(uri.Host)
            || !string.IsNullOrEmpty(uri.UserInfo)) return false;
        normalized = value.TrimEnd('/');
        return true;
    }

    private static bool TryNormalizeExchangeUrl(string value, out string normalized)
    {
        normalized = string.Empty;
        if (value.Length is 0 or > 2048
            || !Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https" or "ws" or "wss")
            || string.IsNullOrWhiteSpace(uri.Host)
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !string.IsNullOrEmpty(uri.Fragment)
            || ContainsSensitiveQueryParameter(uri)) return false;
        normalized = value.TrimEnd('/');
        return true;
    }

    public static string? ValidateExternalExchangeTransport(string targetUrl, string transformerType)
    {
        if (!Uri.TryCreate(targetUrl, UriKind.Absolute, out var uri))
            return "外部租户 Exchange 目标地址格式无效";

        var isStreamingAsr = string.Equals(
            transformerType,
            "doubao-asr-stream",
            StringComparison.OrdinalIgnoreCase);
        if (isStreamingAsr)
            return uri.Scheme == "wss"
                ? null
                : "豆包流式语音识别必须使用公网 WSS 地址";
        return uri.Scheme is "http" or "https"
            ? null
            : "WSS 仅支持豆包流式语音识别；其他 Exchange 必须使用 HTTP 或 HTTPS";
    }

    public static bool IsSafeExternalExchangeAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
            address = address.MapToIPv4();

        if (IPAddress.IsLoopback(address))
            return false;

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var bytes = address.GetAddressBytes();
            if (bytes.Length != 4) return false;
            var b0 = bytes[0];
            var b1 = bytes[1];
            var b2 = bytes[2];
            var b3 = bytes[3];
            if (b0 == 192 && b1 == 0 && b2 == 0 && b3 is 9 or 10)
                return true;
            return !(b0 == 0
                     || b0 == 10
                     || b0 == 127
                     || (b0 == 100 && b1 is >= 64 and <= 127)
                     || (b0 == 169 && b1 == 254)
                     || (b0 == 172 && b1 is >= 16 and <= 31)
                     || (b0 == 192 && b1 == 0 && b2 == 0)
                     || (b0 == 192 && b1 == 0 && b2 == 2)
                     || (b0 == 192 && b1 == 88 && b2 == 99)
                     || (b0 == 192 && b1 == 168)
                     || (b0 == 198 && b1 is 18 or 19)
                     || (b0 == 198 && b1 == 51 && b2 == 100)
                     || (b0 == 203 && b1 == 0 && b2 == 113)
                     || b0 >= 224);
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            var bytes = address.GetAddressBytes();
            return !(address.Equals(IPAddress.IPv6Any)
                     || address.Equals(IPAddress.IPv6Loopback)
                     || address.Equals(IPAddress.IPv6None)
                     || address.IsIPv6LinkLocal
                     || address.IsIPv6SiteLocal
                     || HasAddressPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 96)
                     || HasAddressPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)
                     || HasAddressPrefix(bytes, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 64)
                     || HasAddressPrefix(bytes, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01], 64)
                     || (HasAddressPrefix(bytes, [0x20, 0x01, 0x00], 23) && !IsGloballyReachableIetfProtocolAssignment(bytes))
                     || HasAddressPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)
                     || HasAddressPrefix(bytes, [0x20, 0x02], 16)
                     || HasAddressPrefix(bytes, [0x3f, 0xff, 0x00], 20)
                     || HasAddressPrefix(bytes, [0x5f, 0x00], 16)
                     || bytes[0] == 0xff
                     || (bytes[0] & 0xfe) == 0xfc);
        }

        return false;
    }

    private static bool IsGloballyReachableIetfProtocolAssignment(byte[] address)
    {
        var isProtocolAnycast = HasAddressPrefix(address, [0x20, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00], 64)
                                && address[8] == 0 && address[9] == 0 && address[10] == 0
                                && address[11] == 0 && address[12] == 0 && address[13] == 0 && address[14] == 0
                                && address[15] is >= 1 and <= 3;
        return isProtocolAnycast
               || HasAddressPrefix(address, [0x20, 0x01, 0x00, 0x03], 32)
               || HasAddressPrefix(address, [0x20, 0x01, 0x00, 0x04, 0x01, 0x12], 48)
               || HasAddressPrefix(address, [0x20, 0x01, 0x00, 0x20], 28)
               || HasAddressPrefix(address, [0x20, 0x01, 0x00, 0x30], 28);
    }

    private static bool HasAddressPrefix(byte[] address, byte[] prefix, int prefixLength)
    {
        var wholeBytes = prefixLength / 8;
        var remainingBits = prefixLength % 8;
        if (address.Length * 8 < prefixLength || prefix.Length < wholeBytes + (remainingBits > 0 ? 1 : 0))
            return false;
        for (var index = 0; index < wholeBytes; index++)
        {
            if (address[index] != prefix[index]) return false;
        }
        if (remainingBits == 0) return true;
        var mask = (byte)(0xff << (8 - remainingBits));
        return (address[wholeBytes] & mask) == (prefix[wholeBytes] & mask);
    }

    private static bool ContainsSensitiveQueryParameter(Uri uri)
    {
        if (string.IsNullOrEmpty(uri.Query)) return false;
        string[] sensitiveNames =
        [
            "key", "apikey", "xapikey", "accesskey", "accesskeyid",
            "token", "accesstoken", "authtoken", "refreshtoken",
            "secret", "clientsecret", "signature", "xamzsignature",
            "password", "auth", "authorization",
        ];
        foreach (var part in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = part.IndexOf('=');
            var rawName = separator >= 0 ? part[..separator] : part;
            var name = new string(Uri.UnescapeDataString(rawName.Replace('+', ' '))
                .Where(char.IsLetterOrDigit)
                .Select(char.ToLowerInvariant)
                .ToArray());
            if (sensitiveNames.Contains(name, StringComparer.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string? TrimToNull(string? value, int maxLength, string label, out string error)
    {
        error = string.Empty;
        var normalized = value?.Trim();
        if (normalized?.Length > maxLength)
        {
            error = $"{label}长度超出限制";
            return null;
        }
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }

    private static bool Fail(string message, out string error)
    {
        error = message;
        return false;
    }

    private static BsonValue ToBsonValue(string? value) => value is null ? BsonNull.Value : value;
    private static BsonValue ToBsonValue(int? value) => value is null ? BsonNull.Value : value.Value;
    private static BsonValue ToBsonValue(decimal? value) => value is null ? BsonNull.Value : new BsonDecimal128(value.Value);
}
