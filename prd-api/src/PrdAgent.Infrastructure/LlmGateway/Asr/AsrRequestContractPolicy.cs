using System.Text.Json.Nodes;

namespace PrdAgent.Infrastructure.LlmGateway.Asr;

/// <summary>
/// ASR 上游请求契约的单一判定入口。
/// 业务层必须先按最终物理模型构建 wire 请求，再锁定同一个 Offering 发送，
/// 禁止模型、端点和参数分别解析后发生协议漂移。
/// </summary>
public static class AsrRequestContractPolicy
{
    public const string TranscriptionsEndpoint = "/v1/audio/transcriptions";
    public const string ChatCompletionsEndpoint = "/v1/chat/completions";
    public const string InvalidRouteErrorCode = "ASR_ROUTE_CONTRACT_INVALID";

    public static Dictionary<string, object> BuildTranscriptionFields(
        string? model,
        string? language = null)
    {
        var effectiveModel = string.IsNullOrWhiteSpace(model) ? "whisper-1" : model.Trim();
        var compactJson = UsesCompactJson(effectiveModel);
        var fields = new Dictionary<string, object>
        {
            ["model"] = effectiveModel,
            ["response_format"] = compactJson ? "json" : "verbose_json",
        };
        if (!compactJson)
            fields["timestamp_granularities[]"] = "segment";
        if (!string.IsNullOrWhiteSpace(language))
            fields["language"] = language.Trim();
        return fields;
    }

    public static bool UsesCompactJson(string? model)
    {
        var normalized = model?.Trim();
        if (string.IsNullOrWhiteSpace(normalized)) return false;
        var separator = normalized.LastIndexOf('/');
        var modelLeaf = separator >= 0 ? normalized[(separator + 1)..] : normalized;
        return modelLeaf.StartsWith("gpt-4o-transcribe", StringComparison.OrdinalIgnoreCase)
            || modelLeaf.StartsWith("gpt-4o-mini-transcribe", StringComparison.OrdinalIgnoreCase);
    }

    public static bool ShouldUseChatAudio(string? model, string? protocol, string? platformType)
    {
        if (string.IsNullOrWhiteSpace(model)) return false;

        var normalizedModel = model.Trim().ToLowerInvariant();
        if (normalizedModel.Contains("whisper", StringComparison.Ordinal)
            || normalizedModel.Contains("transcribe", StringComparison.Ordinal))
        {
            return false;
        }

        if (!normalizedModel.Contains("audio", StringComparison.Ordinal)
            && !normalizedModel.Contains("gemini", StringComparison.Ordinal))
        {
            return false;
        }

        var normalizedProtocol = Normalize(protocol);
        if (normalizedProtocol != null)
        {
            return normalizedProtocol is "openai" or "openai-compatible" or "openrouter";
        }

        var normalizedPlatform = Normalize(platformType);
        return normalizedPlatform is not ("google" or "gemini" or "anthropic" or "claude" or "exchange");
    }

    public static JsonObject BuildChatAudioBody(string? model, byte[] audioBytes, string prompt)
    {
        return new JsonObject
        {
            ["model"] = model,
            ["modalities"] = new JsonArray("text"),
            ["temperature"] = 0,
            ["messages"] = new JsonArray
            {
                new JsonObject
                {
                    ["role"] = "user",
                    ["content"] = new JsonArray
                    {
                        new JsonObject { ["type"] = "text", ["text"] = prompt },
                        new JsonObject
                        {
                            ["type"] = "input_audio",
                            ["input_audio"] = new JsonObject
                            {
                                ["data"] = Convert.ToBase64String(audioBytes),
                                ["format"] = "wav",
                            },
                        },
                    },
                },
            },
        };
    }

    /// <summary>
    /// 只拒绝可以确定为相反协议的标准端点；自定义 Exchange 路径由 Transformer 自己负责。
    /// </summary>
    public static bool TryValidateOfferingEndpoint(
        string? model,
        string? protocol,
        string? platformType,
        string? offeringEndpointPath,
        bool isExchange,
        out string? error)
    {
        error = null;
        if (isExchange || string.IsNullOrWhiteSpace(offeringEndpointPath)) return true;

        var endpoint = NormalizeEndpointPath(offeringEndpointPath);
        var isChatEndpoint = endpoint.EndsWith("/chat/completions", StringComparison.Ordinal);
        var isTranscriptionEndpoint = endpoint.EndsWith("/audio/transcriptions", StringComparison.Ordinal);
        if (!isChatEndpoint && !isTranscriptionEndpoint) return true;

        var shouldUseChat = ShouldUseChatAudio(model, protocol, platformType);
        if ((shouldUseChat && isTranscriptionEndpoint) || (!shouldUseChat && isChatEndpoint))
        {
            var expected = shouldUseChat ? ChatCompletionsEndpoint : TranscriptionsEndpoint;
            error = $"{InvalidRouteErrorCode}: 模型 {model ?? "未知"} 的 Offering 端点为 {offeringEndpointPath}，预期 {expected}";
            return false;
        }

        return true;
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
