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
                choices.ValueKind != JsonValueKind.Array ||
                choices.GetArrayLength() == 0)
            {
                // 可能是 usage 块（stream_options.include_usage 最后一个独立块）
                if (root.TryGetProperty("usage", out var usageEl) &&
                    usageEl.ValueKind == JsonValueKind.Object)
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

            // 提取 delta 内容（优先使用 delta.content，备选 message.content）
            // reasoning_content 单独作为 Thinking 类型返回，不混入正文
            string? content = null;
            string? thinkingContent = null;
            if (choice.TryGetProperty("delta", out var delta))
            {
                // 标准 content 字段
                if (delta.TryGetProperty("content", out var contentEl) &&
                    contentEl.ValueKind == JsonValueKind.String)
                {
                    content = contentEl.GetString();
                }
                // DeepSeek reasoning 模式：reasoning_content 字段（思考过程）
                // 单独提取为 Thinking 类型，不与正文内容混合
                if (delta.TryGetProperty("reasoning_content", out var reasoningEl) &&
                    reasoningEl.ValueKind == JsonValueKind.String)
                {
                    thinkingContent = reasoningEl.GetString();
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
            // 注意：当 stream_options.include_usage=true 时，中间 chunk 会携带 "usage": null，
            // 必须检查 ValueKind 为 Object 才能安全解析，否则 TryGetProperty 会抛异常。
            GatewayTokenUsage? usage = null;
            if (root.TryGetProperty("usage", out var usageEl2) &&
                usageEl2.ValueKind == JsonValueKind.Object)
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

            // reasoning_content 优先返回为 Thinking（独立于 content）
            // DeepSeek R1 等模型：thinking 阶段 content=null, reasoning_content 有值；
            // content 阶段 reasoning_content=null, content 有值。两者不重叠。
            if (!string.IsNullOrEmpty(thinkingContent))
            {
                return GatewayStreamChunk.Thinking(thinkingContent);
            }

            if (!string.IsNullOrEmpty(content))
            {
                return GatewayStreamChunk.Text(content);
            }

            return null;
        }
        catch (Exception ex)
        {
            // 不再静默吞掉异常，保留异常信息供 Gateway 层日志使用
            throw new InvalidOperationException(
                $"[OpenAIAdapter] ParseStreamChunk failed: {sseData?[..Math.Min(sseData.Length, 120)]}",
                ex);
        }
    }

    public GatewayTokenUsage? ParseTokenUsage(string responseBody)
    {
        try
        {
            using var doc = JsonDocument.Parse(responseBody);
            if (doc.RootElement.TryGetProperty("usage", out var usage) &&
                usage.ValueKind == JsonValueKind.Object)
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

        if (usage.TryGetProperty("prompt_tokens", out var pt) && pt.ValueKind == JsonValueKind.Number)
            inputTokens = pt.GetInt32();

        if (usage.TryGetProperty("completion_tokens", out var ct) && ct.ValueKind == JsonValueKind.Number)
            outputTokens = ct.GetInt32();

        return new GatewayTokenUsage
        {
            InputTokens = inputTokens,
            OutputTokens = outputTokens,
            Source = "response_body"
        };
    }
}
