using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Infrastructure.LlmGateway.Adapters;

/// <summary>
/// OpenAI 兼容平台适配器
/// 支持: OpenAI, Azure OpenAI, DeepSeek, 通义千问, 智谱等 OpenAI 兼容 API
/// </summary>
public class OpenAIGatewayAdapter : IGatewayAdapter
{
    public string PlatformType => "openai";

    public string BuildEndpoint(string apiBase, string modelType)
    {
        var baseUrl = apiBase.TrimEnd('/');

        // 移除可能的路径后缀
        if (baseUrl.EndsWith("/v1"))
            baseUrl = baseUrl[..^3];

        return modelType.ToLowerInvariant() switch
        {
            "generation" => $"{baseUrl}/v1/images/generations",
            "embedding" => $"{baseUrl}/v1/embeddings",
            _ => $"{baseUrl}/v1/chat/completions"
        };
    }

    public HttpRequestMessage BuildHttpRequest(
        string endpoint,
        string? apiKey,
        JsonObject requestBody,
        bool enablePromptCache = false)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, endpoint);

        // 设置 Authorization
        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        }

        // 流式响应时请求 usage 统计
        if (requestBody.TryGetPropertyValue("stream", out var streamNode) &&
            streamNode?.GetValue<bool>() == true)
        {
            // 添加 stream_options 以获取流式响应中的 usage
            requestBody["stream_options"] = new JsonObject
            {
                ["include_usage"] = true
            };
        }

        var json = requestBody.ToJsonString();
        request.Content = new StringContent(json, Encoding.UTF8, "application/json");

        return request;
    }

    public GatewayStreamChunk? ParseStreamChunk(string sseData)
    {
        if (string.IsNullOrWhiteSpace(sseData))
            return null;

        try
        {
            using var doc = JsonDocument.Parse(sseData);
            var root = doc.RootElement;

            // 检查是否有 choices
            if (!root.TryGetProperty("choices", out var choices) ||
                choices.GetArrayLength() == 0)
            {
                // 可能是 usage 块
                if (root.TryGetProperty("usage", out var usageEl))
                {
                    return new GatewayStreamChunk
                    {
                        Type = GatewayChunkType.Done,
                        TokenUsage = ParseUsageElement(usageEl)
                    };
                }
                return null;
            }

            var choice = choices[0];

            // 检查 finish_reason
            string? finishReason = null;
            if (choice.TryGetProperty("finish_reason", out var fr) &&
                fr.ValueKind == JsonValueKind.String)
            {
                finishReason = fr.GetString();
            }

            // 提取 delta 内容
            string? content = null;
            if (choice.TryGetProperty("delta", out var delta) &&
                delta.TryGetProperty("content", out var contentEl) &&
                contentEl.ValueKind == JsonValueKind.String)
            {
                content = contentEl.GetString();
            }

            // 检查 usage（可能在最后一个 chunk）
            GatewayTokenUsage? usage = null;
            if (root.TryGetProperty("usage", out var usageEl2))
            {
                usage = ParseUsageElement(usageEl2);
            }

            if (!string.IsNullOrEmpty(finishReason))
            {
                return new GatewayStreamChunk
                {
                    Type = GatewayChunkType.Done,
                    Content = content,
                    FinishReason = finishReason,
                    TokenUsage = usage
                };
            }

            if (!string.IsNullOrEmpty(content))
            {
                return GatewayStreamChunk.Text(content);
            }

            return null;
        }
        catch
        {
            return null;
        }
    }

    public GatewayTokenUsage? ParseTokenUsage(string responseBody)
    {
        try
        {
            using var doc = JsonDocument.Parse(responseBody);
            if (doc.RootElement.TryGetProperty("usage", out var usage))
            {
                return ParseUsageElement(usage);
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    private static GatewayTokenUsage ParseUsageElement(JsonElement usage)
    {
        int? inputTokens = null;
        int? outputTokens = null;

        if (usage.TryGetProperty("prompt_tokens", out var pt))
            inputTokens = pt.GetInt32();

        if (usage.TryGetProperty("completion_tokens", out var ct))
            outputTokens = ct.GetInt32();

        return new GatewayTokenUsage
        {
            InputTokens = inputTokens,
            OutputTokens = outputTokens,
            Source = "response_body"
        };
    }
}
