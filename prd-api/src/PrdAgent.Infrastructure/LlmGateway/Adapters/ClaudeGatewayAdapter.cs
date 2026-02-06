using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Infrastructure.LlmGateway.Adapters;

/// <summary>
/// Anthropic Claude 平台适配器
/// 支持 Prompt Caching 功能
/// </summary>
public class ClaudeGatewayAdapter : IGatewayAdapter
{
    public string PlatformType => "claude";

    private const string AnthropicVersion = "2023-06-01";
    private const string PromptCachingBeta = "prompt-caching-2024-07-31";

    public string BuildEndpoint(string apiBase, string modelType)
    {
        var baseUrl = apiBase.TrimEnd('/');

        // 移除可能的路径后缀
        if (baseUrl.EndsWith("/v1"))
            baseUrl = baseUrl[..^3];

        return $"{baseUrl}/v1/messages";
    }

    public HttpRequestMessage BuildHttpRequest(
        string endpoint,
        string? apiKey,
        JsonObject requestBody,
        bool enablePromptCache = false)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, endpoint);

        // Claude 使用 x-api-key 而非 Bearer token
        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            request.Headers.Add("x-api-key", apiKey);
        }

        // 必须的版本头
        request.Headers.Add("anthropic-version", AnthropicVersion);

        // Prompt Caching Beta 头
        if (enablePromptCache)
        {
            request.Headers.Add("anthropic-beta", PromptCachingBeta);
        }

        // Claude 的请求格式与 OpenAI 略有不同
        // 需要将 messages 格式转换
        var claudeBody = ConvertToClaudeFormat(requestBody, enablePromptCache);

        var json = claudeBody.ToJsonString();
        request.Content = new StringContent(json, Encoding.UTF8, "application/json");

        return request;
    }

    private static JsonObject ConvertToClaudeFormat(JsonObject openaiBody, bool enablePromptCache)
    {
        var result = new JsonObject();

        // 复制 model
        if (openaiBody.TryGetPropertyValue("model", out var model))
        {
            result["model"] = model?.DeepClone();
        }

        // 复制 max_tokens
        if (openaiBody.TryGetPropertyValue("max_tokens", out var maxTokens))
        {
            result["max_tokens"] = maxTokens?.DeepClone();
        }
        else
        {
            result["max_tokens"] = 4096; // Claude 必须指定
        }

        // 处理 system prompt
        if (openaiBody.TryGetPropertyValue("messages", out var messagesNode) &&
            messagesNode is JsonArray messages)
        {
            var systemMessages = new List<JsonObject>();
            var userMessages = new JsonArray();

            foreach (var msg in messages)
            {
                if (msg is not JsonObject msgObj) continue;

                var role = msgObj["role"]?.GetValue<string>();
                if (role == "system")
                {
                    var content = msgObj["content"]?.GetValue<string>() ?? "";
                    var systemBlock = new JsonObject { ["type"] = "text", ["text"] = content };

                    // Prompt Cache: 给最后一个 system block 添加 cache_control
                    if (enablePromptCache)
                    {
                        systemBlock["cache_control"] = new JsonObject { ["type"] = "ephemeral" };
                    }

                    systemMessages.Add(systemBlock);
                }
                else
                {
                    userMessages.Add(msgObj.DeepClone());
                }
            }

            // 设置 system
            if (systemMessages.Count > 0)
            {
                var systemArray = new JsonArray();
                foreach (var s in systemMessages)
                    systemArray.Add(s);
                result["system"] = systemArray;
            }

            // 设置 messages
            result["messages"] = userMessages;
        }

        // 复制 stream
        if (openaiBody.TryGetPropertyValue("stream", out var stream))
        {
            result["stream"] = stream?.DeepClone();
        }

        // 复制 temperature
        if (openaiBody.TryGetPropertyValue("temperature", out var temp))
        {
            result["temperature"] = temp?.DeepClone();
        }

        return result;
    }

    public GatewayStreamChunk? ParseStreamChunk(string sseData)
    {
        if (string.IsNullOrWhiteSpace(sseData))
            return null;

        try
        {
            using var doc = JsonDocument.Parse(sseData);
            var root = doc.RootElement;

            // Claude SSE 事件类型
            if (!root.TryGetProperty("type", out var typeEl))
                return null;

            var eventType = typeEl.GetString();

            switch (eventType)
            {
                case "content_block_delta":
                    if (root.TryGetProperty("delta", out var delta) &&
                        delta.TryGetProperty("text", out var textEl))
                    {
                        return GatewayStreamChunk.Text(textEl.GetString() ?? "");
                    }
                    break;

                case "message_delta":
                    // 包含 stop_reason 和 usage
                    string? stopReason = null;
                    GatewayTokenUsage? usage = null;

                    if (root.TryGetProperty("delta", out var msgDelta) &&
                        msgDelta.TryGetProperty("stop_reason", out var sr))
                    {
                        stopReason = sr.GetString();
                    }

                    if (root.TryGetProperty("usage", out var usageEl) &&
                        usageEl.ValueKind == JsonValueKind.Object)
                    {
                        usage = ParseUsageElement(usageEl);
                    }

                    if (stopReason != null)
                    {
                        return new GatewayStreamChunk
                        {
                            Type = GatewayChunkType.Done,
                            FinishReason = stopReason,
                            TokenUsage = usage
                        };
                    }
                    break;

                case "message_stop":
                    return new GatewayStreamChunk
                    {
                        Type = GatewayChunkType.Done,
                        FinishReason = "stop"
                    };

                case "error":
                    if (root.TryGetProperty("error", out var error) &&
                        error.TryGetProperty("message", out var errMsg))
                    {
                        return GatewayStreamChunk.Fail(errMsg.GetString() ?? "Unknown error");
                    }
                    break;
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
        int? cacheCreation = null;
        int? cacheRead = null;

        if (usage.TryGetProperty("input_tokens", out var it) && it.ValueKind == JsonValueKind.Number)
            inputTokens = it.GetInt32();

        if (usage.TryGetProperty("output_tokens", out var ot) && ot.ValueKind == JsonValueKind.Number)
            outputTokens = ot.GetInt32();

        if (usage.TryGetProperty("cache_creation_input_tokens", out var cc) && cc.ValueKind == JsonValueKind.Number)
            cacheCreation = cc.GetInt32();

        if (usage.TryGetProperty("cache_read_input_tokens", out var cr) && cr.ValueKind == JsonValueKind.Number)
            cacheRead = cr.GetInt32();

        return new GatewayTokenUsage
        {
            InputTokens = inputTokens,
            OutputTokens = outputTokens,
            CacheCreationInputTokens = cacheCreation,
            CacheReadInputTokens = cacheRead,
            Source = "response_body"
        };
    }
}
