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
            var nonSystemMessages = new List<JsonObject>();

            foreach (var msg in messages)
            {
                if (msg is not JsonObject msgObj) continue;

                var role = msgObj["role"]?.GetValue<string>();
                if (role == "system")
                {
                    var content = ExtractTextContent(msgObj["content"]);
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
                    nonSystemMessages.Add(msgObj);
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

            // 设置 messages —— 把 OpenAI 工具调用消息（assistant.tool_calls / role:"tool"）翻译成
            // Claude 的 tool_use / tool_result content block，否则工具循环的后续请求会让 Claude 池 400。
            result["messages"] = BuildClaudeMessages(nonSystemMessages);
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

        // ── 函数调用（tools/tool_choice）协议原生转换（G3，照抄 transformer 模式）──
        // OpenAI tools:[{type:function, function:{name, description, parameters}}]
        //   → Claude tools:[{name, description, input_schema}]
        // 两侧 schema 不同，禁止盲透传（这正是"全归一"会出错的地方）。
        // tool_choice:"none" = 调用方显式禁用工具调用。Claude 旧版无 none 语义，且即便附了 tools 默认 auto
        // 仍可能 emit tool_use → 违背调用方意图。最稳的等价：**整段不附 tools**（无 tools 则 Claude 不可能调用）。
        var toolChoiceNone = openaiBody.TryGetPropertyValue("tool_choice", out var tcCheck)
            && tcCheck is JsonValue tcv && tcv.TryGetValue<string>(out var tcStr) && tcStr == "none";

        if (!toolChoiceNone &&
            openaiBody.TryGetPropertyValue("tools", out var toolsNode) &&
            toolsNode is JsonArray openaiTools && openaiTools.Count > 0)
        {
            var claudeTools = ConvertToolsToClaude(openaiTools);
            if (claudeTools.Count > 0)
            {
                result["tools"] = claudeTools;

                if (openaiBody.TryGetPropertyValue("tool_choice", out var tcNode) && tcNode is not null)
                {
                    var claudeChoice = ConvertToolChoiceToClaude(tcNode);
                    if (claudeChoice != null)
                        result["tool_choice"] = claudeChoice;
                }
            }
        }

        return result;
    }

    /// <summary>
    /// OpenAI tools → Claude tools。OpenAI 用 function 包裹 + parameters，Claude 用扁平 name + input_schema。
    /// 已是 Claude 形状（无 function 包裹、有 input_schema）的条目原样克隆透传。
    /// </summary>
    private static JsonArray ConvertToolsToClaude(JsonArray openaiTools)
    {
        var claudeTools = new JsonArray();
        foreach (var tool in openaiTools)
        {
            if (tool is not JsonObject o) continue;

            // OpenAI 形状：{type:"function", function:{name, description, parameters}}
            if (o["function"] is JsonObject fn)
            {
                var ct = new JsonObject
                {
                    ["name"] = fn["name"]?.DeepClone() ?? string.Empty
                };
                if (fn["description"] is { } desc)
                    ct["description"] = desc.DeepClone();
                // OpenAI parameters == Claude input_schema（都是 JSON Schema 对象）
                ct["input_schema"] = fn["parameters"]?.DeepClone()
                    ?? new JsonObject { ["type"] = "object" };
                claudeTools.Add(ct);
            }
            // 已是 Claude 形状（有 input_schema / name）→ 原样克隆，不二次包裹
            else if (o["input_schema"] is not null || o["name"] is not null)
            {
                claudeTools.Add(o.DeepClone());
            }
        }
        return claudeTools;
    }

    /// <summary>
    /// OpenAI tool_choice → Claude tool_choice。
    /// "auto"→{type:auto}；"required"/"any"→{type:any}；{type:function,function:{name}}→{type:tool,name}；
    /// "none"→ 返回 null（不强制，留给 Claude 默认 auto；Claude 旧版无 none 语义，避免 400）。
    /// </summary>
    private static JsonObject? ConvertToolChoiceToClaude(JsonNode tcNode)
    {
        if (tcNode is JsonValue v && v.TryGetValue<string>(out var s))
        {
            return s switch
            {
                "auto" => new JsonObject { ["type"] = "auto" },
                "required" or "any" => new JsonObject { ["type"] = "any" },
                _ => null // "none" 及未知 → 不设
            };
        }

        if (tcNode is JsonObject o && (string?)o["type"] == "function")
        {
            var name = o["function"]?["name"];
            if (name is not null)
                return new JsonObject { ["type"] = "tool", ["name"] = name.DeepClone() };
        }

        return null;
    }

    /// <summary>
    /// 把 OpenAI 风格消息列表翻译成 Claude messages：
    ///   - assistant 带 tool_calls → assistant content:[{type:text}?, {type:tool_use, id, name, input}…]
    ///   - role:"tool"（工具结果）→ user content:[{type:tool_result, tool_use_id, content}]，**连续的合并进同一 user 轮**
    ///     （Claude 要求 tool_result 在紧跟 assistant tool_use 的那个 user 轮里；并行调用的多个结果同属一轮）。
    ///   - 其余消息（普通文本 user/assistant）原样克隆（content 为 string 时 Claude 直接兼容）。
    /// </summary>
    private static JsonArray BuildClaudeMessages(List<JsonObject> msgs)
    {
        var outArr = new JsonArray();
        JsonObject? pendingToolUser = null;

        void FlushToolUser()
        {
            if (pendingToolUser != null) { outArr.Add(pendingToolUser); pendingToolUser = null; }
        }

        foreach (var m in msgs)
        {
            var role = m["role"]?.GetValue<string>();

            if (role == "tool")
            {
                var block = new JsonObject
                {
                    ["type"] = "tool_result",
                    ["tool_use_id"] = m["tool_call_id"]?.GetValue<string>() ?? string.Empty,
                    ["content"] = ExtractTextContent(m["content"]),
                };
                pendingToolUser ??= new JsonObject { ["role"] = "user", ["content"] = new JsonArray() };
                ((JsonArray)pendingToolUser["content"]!).Add(block);
                continue;
            }

            // 非 tool 消息：先把累积的 tool_result user 轮落定，保持顺序
            FlushToolUser();

            if (role == "assistant" && m["tool_calls"] is JsonArray toolCalls && toolCalls.Count > 0)
            {
                var contentArr = new JsonArray();
                var text = ExtractTextContent(m["content"]);
                if (!string.IsNullOrEmpty(text))
                    contentArr.Add(new JsonObject { ["type"] = "text", ["text"] = text });

                foreach (var tc in toolCalls)
                {
                    if (tc is not JsonObject tco) continue;
                    var fn = tco["function"] as JsonObject;
                    var argsStr = fn?["arguments"]?.GetValue<string>() ?? "{}";
                    JsonNode? input;
                    try { input = JsonNode.Parse(string.IsNullOrWhiteSpace(argsStr) ? "{}" : argsStr); }
                    catch { input = new JsonObject(); }
                    contentArr.Add(new JsonObject
                    {
                        ["type"] = "tool_use",
                        ["id"] = tco["id"]?.GetValue<string>() ?? string.Empty,
                        ["name"] = fn?["name"]?.GetValue<string>() ?? string.Empty,
                        ["input"] = input ?? new JsonObject(),
                    });
                }
                outArr.Add(new JsonObject { ["role"] = "assistant", ["content"] = contentArr });
            }
            else
            {
                outArr.Add(m.DeepClone());
            }
        }

        FlushToolUser();
        return outArr;
    }

    /// <summary>
    /// 提取消息 content 的纯文本：content 可能是 string，或 OpenAI 的 [{type:"text",text},…] 数组。
    /// 非文本块（如 image_url）忽略——视觉透传不在本工具翻译范围内。
    /// </summary>
    private static string ExtractTextContent(JsonNode? content)
    {
        if (content == null) return string.Empty;
        if (content is JsonValue v && v.TryGetValue<string>(out var s)) return s;
        if (content is JsonArray arr)
        {
            var sb = new StringBuilder();
            foreach (var part in arr)
                if (part is JsonObject po && (string?)po["type"] == "text")
                    sb.Append(po["text"]?.GetValue<string>() ?? string.Empty);
            return sb.ToString();
        }
        return string.Empty;
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

    /// <summary>
    /// 非流式：Claude content[].type=="tool_use" → OpenAI 形状 tool_calls。
    /// Claude: {type:"tool_use", id, name, input:{...}} → OpenAI: {id, type:"function", function:{name, arguments:"<json>"}}。
    /// arguments 必须是 JSON 字符串（OpenAI 约定）。无 tool_use 返回 null。
    /// 兼容部分 Claude 代理直接回 OpenAI 形状 choices[0].message.tool_calls 的情况。
    /// </summary>
    public JsonArray? ParseToolCalls(string responseBody)
    {
        try
        {
            if (JsonNode.Parse(responseBody) is not JsonObject root) return null;

            // Claude 原生：content[].type == "tool_use"
            if (root["content"] is JsonArray content)
            {
                JsonArray? result = null;
                var index = 0;
                foreach (var block in content)
                {
                    if (block is not JsonObject b) continue;
                    if ((string?)b["type"] != "tool_use") continue;

                    result ??= new JsonArray();
                    var input = b["input"]?.DeepClone() ?? new JsonObject();
                    result.Add(new JsonObject
                    {
                        ["id"] = (string?)b["id"] ?? $"call_{index}",
                        ["type"] = "function",
                        ["index"] = index,
                        ["function"] = new JsonObject
                        {
                            ["name"] = (string?)b["name"] ?? string.Empty,
                            ["arguments"] = input.ToJsonString()
                        }
                    });
                    index++;
                }
                if (result != null) return result;
            }

            // 兼容：OpenAI 形状代理 choices[0].message.tool_calls
            if (root["choices"] is JsonArray choices && choices.Count > 0 &&
                choices[0] is JsonObject c0 &&
                c0["message"] is JsonObject msg &&
                msg["tool_calls"] is JsonArray tc && tc.Count > 0)
            {
                return tc.DeepClone() as JsonArray;
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }
}
