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

        // ── 协议下沉·透传保真（不再「只抄 5 个字段」拍平采样参数）──
        // 历史 bug：本方法早期只复制 model/max_tokens/messages/stream/temperature，
        // 调用方（含 Open Platform OpenAI 兼容代理，body 全量透传）设置的 top_p / top_k /
        // stop 等被静默丢弃 → 路由到 Claude 池时采样行为与用户意图不符。
        // 这里只透传「Claude Messages API 原生兼容」的字段，零 400 风险：
        //   - top_p          ：OpenAI / Claude 同名同义，直接透传
        //   - top_k          ：Claude 原生支持（OpenAI 无此字段，存在即透传）
        //   - stop → stop_sequences：语义相同但字段名不同，需改名（OpenAI 用 stop，
        //                       Claude 用 stop_sequences；接受 string 或 string[]）
        // 注意：frequency_penalty / presence_penalty / n / logit_bias / response_format /
        //   stream_options 等是 OpenAI 专有、Claude 会 400，故「不」透传（白名单而非黑名单）。
        //   tools / tool_choice 两侧 schema 不同（OpenAI function 包裹 vs Claude input_schema），
        //   需协议原生转换器处理，属 F4「能力描述符 + 协议原生处理器」一波，见
        //   doc/design.llm-gateway-unification.md 决策一。本次不做半成品转换。
        if (openaiBody.TryGetPropertyValue("top_p", out var topP) && topP is not null)
        {
            result["top_p"] = topP.DeepClone();
        }
        if (openaiBody.TryGetPropertyValue("top_k", out var topK) && topK is not null)
        {
            result["top_k"] = topK.DeepClone();
        }
        if (openaiBody.TryGetPropertyValue("stop", out var stop) && stop is not null)
        {
            // OpenAI stop 允许 string 或 string[]；Claude stop_sequences 要求 string[]。
            result["stop_sequences"] = stop is JsonArray
                ? stop.DeepClone()
                : new JsonArray(stop.DeepClone());
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

    public string? ParseMessageContent(string responseBody)
    {
        try
        {
            using var doc = JsonDocument.Parse(responseBody);

            // Claude Messages API format: content[0].text
            if (doc.RootElement.TryGetProperty("content", out var content) &&
                content.ValueKind == JsonValueKind.Array &&
                content.GetArrayLength() > 0)
            {
                var firstBlock = content[0];
                if (firstBlock.TryGetProperty("text", out var text) &&
                    text.ValueKind == JsonValueKind.String)
                {
                    return text.GetString();
                }
            }

            // Fallback: OpenAI-compatible format (some Claude proxies)
            if (doc.RootElement.TryGetProperty("choices", out var choices) &&
                choices.ValueKind == JsonValueKind.Array &&
                choices.GetArrayLength() > 0)
            {
                var firstChoice = choices[0];
                if (firstChoice.TryGetProperty("message", out var message) &&
                    message.TryGetProperty("content", out var msgContent) &&
                    msgContent.ValueKind == JsonValueKind.String)
                {
                    return msgContent.GetString();
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
