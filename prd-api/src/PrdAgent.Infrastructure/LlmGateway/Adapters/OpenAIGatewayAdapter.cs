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

    /// <summary>
    /// 解析 SSE chunk — 使用 Utf8JsonReader 单遍扫描提取关键字段
    /// 不分配 JsonDocument，不嵌套 TryGetProperty，异常由 Gateway 层统一捕获记录
    /// </summary>
    public GatewayStreamChunk? ParseStreamChunk(string sseData)
    {
        if (string.IsNullOrWhiteSpace(sseData))
            return null;

        var bytes = Encoding.UTF8.GetBytes(sseData);
        var reader = new Utf8JsonReader(bytes);

        string? content = null;
        string? reasoningContent = null;
        string? finishReason = null;
        int? promptTokens = null;
        int? completionTokens = null;

        // 单遍扫描：Utf8JsonReader 自动下沉到所有嵌套层级，
        // 只提取我们关心的 5 个字段名，不管它们在哪一层
        while (reader.Read())
        {
            if (reader.TokenType != JsonTokenType.PropertyName) continue;

            var prop = reader.GetString();
            if (!reader.Read()) break; // 前进到值

            switch (prop)
            {
                case "content":
                    if (reader.TokenType == JsonTokenType.String)
                        content = reader.GetString();
                    break;
                case "reasoning_content":
                    if (reader.TokenType == JsonTokenType.String)
                        reasoningContent = reader.GetString();
                    break;
                case "finish_reason":
                    if (reader.TokenType == JsonTokenType.String)
                        finishReason = reader.GetString();
                    break;
                case "prompt_tokens":
                    if (reader.TokenType == JsonTokenType.Number)
                        promptTokens = reader.GetInt32();
                    break;
                case "completion_tokens":
                    if (reader.TokenType == JsonTokenType.Number)
                        completionTokens = reader.GetInt32();
                    break;
            }
        }

        // 构建 usage（如果有）
        GatewayTokenUsage? usage = (promptTokens != null || completionTokens != null)
            ? new GatewayTokenUsage { InputTokens = promptTokens, OutputTokens = completionTokens, Source = "response_body" }
            : null;

        // 优先级：Done > Thinking > Text > 独立 Usage
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

        if (!string.IsNullOrEmpty(reasoningContent))
            return GatewayStreamChunk.Thinking(reasoningContent);

        if (!string.IsNullOrEmpty(content))
            return GatewayStreamChunk.Text(content);

        // 独立 usage 块（stream_options 最后一个 choices=[] 的块）
        if (usage != null)
            return new GatewayStreamChunk { Type = GatewayChunkType.Done, TokenUsage = usage };

        return null;
    }

    public GatewayTokenUsage? ParseTokenUsage(string responseBody)
    {
        try
        {
            using var doc = JsonDocument.Parse(responseBody);
            if (doc.RootElement.TryGetProperty("usage", out var usage) &&
                usage.ValueKind == JsonValueKind.Object)
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
        catch
        {
            // ignore
        }
        return null;
    }

    public string? ParseMessageContent(string responseBody)
    {
        try
        {
            using var doc = JsonDocument.Parse(responseBody);
            // OpenAI format: choices[0].message.content
            if (doc.RootElement.TryGetProperty("choices", out var choices) &&
                choices.ValueKind == JsonValueKind.Array &&
                choices.GetArrayLength() > 0)
            {
                var firstChoice = choices[0];
                if (firstChoice.TryGetProperty("message", out var message) &&
                    message.TryGetProperty("content", out var content) &&
                    content.ValueKind == JsonValueKind.String)
                {
                    return content.GetString();
                }
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }
}
