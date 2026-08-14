namespace PrdAgent.LlmGw.Governance;

/// <summary>
/// 控制台写入 ASR Offering 时的协议门禁。控制台与 MAP 物理隔离，不能引用业务程序集，
/// 因此这里只校验配置层可以确定的标准端点冲突。
/// </summary>
public static class AsrOfferingContractPolicy
{
    public const string ErrorCode = "ASR_ROUTE_CONTRACT_INVALID";

    public static string? ResolvePhysicalModel(
        string? upstreamModelId,
        string? targetModelName,
        string? legacyTargetModelId = null)
    {
        if (!string.IsNullOrWhiteSpace(upstreamModelId)) return upstreamModelId.Trim();
        if (!string.IsNullOrWhiteSpace(targetModelName)) return targetModelName.Trim();
        return string.IsNullOrWhiteSpace(legacyTargetModelId) ? null : legacyTargetModelId.Trim();
    }

    public static string? Validate(
        string? logicalModelType,
        string? targetKind,
        string? physicalModel,
        string? endpointPath,
        string? protocol = null,
        string? platformType = null)
    {
        if (!string.Equals(logicalModelType?.Trim(), "asr", StringComparison.OrdinalIgnoreCase)
            || string.Equals(targetKind?.Trim(), "exchange", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(endpointPath))
        {
            return null;
        }

        var endpoint = NormalizeEndpointPath(endpointPath);
        var isChatEndpoint = endpoint.EndsWith("/chat/completions", StringComparison.Ordinal);
        var isTranscriptionEndpoint = endpoint.EndsWith("/audio/transcriptions", StringComparison.Ordinal);
        if (!isChatEndpoint && !isTranscriptionEndpoint) return null;

        var requiresTranscriptionEndpoint = !ShouldUseChatAudio(physicalModel, protocol, platformType);
        if ((requiresTranscriptionEndpoint && isChatEndpoint)
            || (!requiresTranscriptionEndpoint && isTranscriptionEndpoint))
        {
            var expected = requiresTranscriptionEndpoint
                ? "/v1/audio/transcriptions"
                : "/v1/chat/completions";
            return $"模型 {physicalModel ?? "未知"} 与 Endpoint path 不兼容，ASR Offering 应使用 {expected}";
        }

        return null;
    }

    private static bool ShouldUseChatAudio(string? model, string? protocol, string? platformType)
    {
        if (string.IsNullOrWhiteSpace(model)) return false;

        var normalizedModel = model.Trim().ToLowerInvariant();
        if (normalizedModel.Contains("whisper", StringComparison.Ordinal)
            || normalizedModel.Contains("transcribe", StringComparison.Ordinal)
            || (!normalizedModel.Contains("audio", StringComparison.Ordinal)
                && !normalizedModel.Contains("gemini", StringComparison.Ordinal)))
        {
            return false;
        }

        var normalizedProtocol = Normalize(protocol);
        if (normalizedProtocol is not null)
            return normalizedProtocol is "openai" or "openai-compatible" or "openrouter";

        var normalizedPlatform = Normalize(platformType);
        return normalizedPlatform is not ("google" or "gemini" or "anthropic" or "claude" or "exchange");
    }

    private static string? Normalize(string? value)
    {
        var normalized = value?.Trim().ToLowerInvariant();
        return string.IsNullOrWhiteSpace(normalized) || normalized == "unknown"
            ? null
            : normalized;
    }

    private static string NormalizeEndpointPath(string endpointPath)
    {
        var endpoint = "/" + endpointPath.Trim().TrimStart('/');
        var suffixIndex = endpoint.IndexOfAny(['?', '#']);
        if (suffixIndex >= 0) endpoint = endpoint[..suffixIndex];
        return endpoint.TrimEnd('/').ToLowerInvariant();
    }
}
