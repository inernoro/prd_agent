using MongoDB.Bson;
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

public static class GatewayConfigurationProvisioning
{
    private static readonly HashSet<string> SupportedModelTypes =
    [
        "chat", "intent", "vision", "generation", "code", "long-context", "embedding",
        "rerank", "asr", "tts", "video-gen", "audio-gen", "moderation",
    ];

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
            ["Capabilities"] = new BsonArray(draft.Capabilities.Select(ToCapabilityDocument)),
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
