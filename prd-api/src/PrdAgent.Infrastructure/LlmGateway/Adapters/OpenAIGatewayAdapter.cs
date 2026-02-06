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

        // 检测 baseUrl 是否已包含版本号
        // 支持的格式: /v1, /v2, /v3, /api/v1, /api/v2, /api/v3 等
        var hasVersionSuffix = System.Text.RegularExpressions.Regex.IsMatch(
            baseUrl, @"/(api/)?v\d+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        // 如果已包含版本号，直接拼接能力路径
        if (hasVersionSuffix)
        {
            return modelType.ToLowerInvariant() switch
            {
                "generation" => $"{baseUrl}/images/generations",
                "embedding" => $"{baseUrl}/embeddings",
                _ => $"{baseUrl}/chat/completions"
            };
        }

        // 标准 OpenAI 格式：添加 /v1 前缀
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

            // 提取 delta 内容：content（正文）和 reasoning_content（推理过程）分开标记
            string? content = null;
            string? reasoning = null;
            if (choice.TryGetProperty("delta", out var delta))
            {
                // 标准 content 字段
                if (delta.TryGetProperty("content", out var contentEl) &&
                    contentEl.ValueKind == JsonValueKind.String)
                {
                    content = contentEl.GetString();
                }
                // reasoning_content 字段（DeepSeek R1、doubao-seed 等推理模型）
                // 标记为 Reasoning 类型，由消费层决定是否输出
                if (delta.TryGetProperty("reasoning_content", out var reasoningEl) &&
                    reasoningEl.ValueKind == JsonValueKind.String)
                {
                    reasoning = reasoningEl.GetString();
                }
            }
            // 某些 OpenAI 兼容 API 可能使用 message.content 而不是 delta.content
            else if (choice.TryGetProperty("message", out var message) &&
                message.TryGetProperty("content", out var msgContentEl) &&
                msgContentEl.ValueKind == JsonValueKind.String)
            {
                content = msgContentEl.GetString();
            }
            // 还有一些 API 可能直接在 choice 下有 text 字段
            else if (choice.TryGetProperty("text", out var textEl) &&
                textEl.ValueKind == JsonValueKind.String)
            {
                content = textEl.GetString();
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

            // 优先返回正文 content
            if (!string.IsNullOrEmpty(content))
            {
                return GatewayStreamChunk.Text(content);
            }

            // 其次返回推理内容（标记为 Reasoning，由消费层决定是否输出）
            if (!string.IsNullOrEmpty(reasoning))
            {
                return GatewayStreamChunk.ReasoningContent(reasoning);
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
