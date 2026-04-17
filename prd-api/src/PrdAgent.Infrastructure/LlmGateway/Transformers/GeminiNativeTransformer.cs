using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway.Transformers;

/// <summary>
/// Gemini 原生协议转换器
/// 标准 OpenAI 格式 ↔ Google Gemini Native API 格式
///
/// 支持场景：
/// - 文本对话（chat）：把 OpenAI messages 转成 Gemini contents/parts
/// - 图片生成（image）：OpenAI `{ prompt, size, n }` → Gemini `{ contents, generationConfig.responseModalities:[IMAGE,TEXT] }`
/// - 图生图（vision / img2img）：OpenAI image_urls 数组 → Gemini parts 里的 inlineData(image/png) 或 fileData(uri)
///
/// URL 模版（在 ModelExchange.TargetUrl 中配置）：
///   https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
/// 运行时 {model} 被 ModelResolver 解析到的实际模型 ID（例如 gemini-3.1-flash-image-preview）替换。
///
/// 认证：TargetAuthScheme 使用 "x-goog-api-key"，Gateway 会自动加上 Google 官方要求的 header。
/// </summary>
public class GeminiNativeTransformer : IExchangeTransformer
{
    public string TransformerType => "gemini-native";

    /// <summary>
    /// Gemini 原生接口 URL 模版已在 LlmGateway 层完成 {model} 替换，这里不再二次改写。
    /// </summary>
    public string? ResolveTargetUrl(string baseUrl, JsonObject standardBody, Dictionary<string, object>? config)
    {
        return null;
    }

    /// <summary>
    /// OpenAI 请求 → Gemini Native 请求
    ///
    /// Chat 输入示例：
    ///   { "messages": [{"role":"user","content":"hi"}], "temperature": 0.7 }
    /// 输出：
    ///   { "contents": [{"role":"user","parts":[{"text":"hi"}]}], "generationConfig": { "temperature": 0.7 } }
    ///
    /// Image 输入示例（OpenAI 兼容的图像生成请求）：
    ///   { "prompt": "a cat", "size": "1024x1024", "n": 1 }
    /// 输出：
    ///   { "contents": [{"role":"user","parts":[{"text":"a cat"}]}],
    ///     "generationConfig": { "responseModalities":["IMAGE","TEXT"],
    ///                           "imageConfig": { "imageSize":"1K", "aspectRatio":"1:1" } } }
    /// </summary>
    public JsonObject TransformRequest(JsonObject standardBody, Dictionary<string, object>? config)
    {
        var geminiBody = new JsonObject();
        var contents = new JsonArray();

        // ========== 情况 1：chat 模式（messages 数组）==========
        if (standardBody.TryGetPropertyValue("messages", out var messagesNode) &&
            messagesNode is JsonArray messages && messages.Count > 0)
        {
            string? systemInstruction = null;

            foreach (var msgNode in messages)
            {
                if (msgNode is not JsonObject msg) continue;

                var role = ReadStringSafe(msg["role"]) ?? "user";

                // system 消息提取为 systemInstruction（Gemini 单独字段）
                if (role == "system")
                {
                    systemInstruction = ExtractTextContent(msg["content"]);
                    continue;
                }

                var content = new JsonObject
                {
                    ["role"] = role == "assistant" ? "model" : "user"
                };

                var parts = new JsonArray();

                // content 可能是字符串或 parts 数组
                var contentNode = msg["content"];
                if (contentNode is JsonValue)
                {
                    parts.Add(new JsonObject { ["text"] = ReadStringSafe(contentNode) ?? string.Empty });
                }
                else if (contentNode is JsonArray contentArr)
                {
                    foreach (var partNode in contentArr)
                    {
                        if (partNode is not JsonObject partObj) continue;
                        var type = ReadStringSafe(partObj["type"]);
                        if (type == "text")
                        {
                            parts.Add(new JsonObject { ["text"] = partObj["text"]?.DeepClone() });
                        }
                        else if (type == "image_url" && partObj["image_url"] is JsonObject imgUrlObj)
                        {
                            var url = ReadStringSafe(imgUrlObj["url"]);
                            var imagePart = BuildImagePart(url);
                            if (imagePart != null) parts.Add(imagePart);
                        }
                    }
                }

                if (parts.Count > 0)
                {
                    content["parts"] = parts;
                    contents.Add(content);
                }
            }

            if (!string.IsNullOrWhiteSpace(systemInstruction))
            {
                geminiBody["systemInstruction"] = new JsonObject
                {
                    ["parts"] = new JsonArray { new JsonObject { ["text"] = systemInstruction } }
                };
            }
        }
        // ========== 情况 2：image-gen 模式（prompt 字段）==========
        else if (standardBody.TryGetPropertyValue("prompt", out var promptNode))
        {
            var parts = new JsonArray
            {
                new JsonObject { ["text"] = ReadStringSafe(promptNode) ?? string.Empty }
            };

            // 图生图：image_urls 数组 → parts 里追加 image 部分
            if (standardBody.TryGetPropertyValue("image_urls", out var imgUrlsNode) &&
                imgUrlsNode is JsonArray imgUrls)
            {
                foreach (var urlNode in imgUrls)
                {
                    var url = ReadStringSafe(urlNode);
                    var imagePart = BuildImagePart(url);
                    if (imagePart != null) parts.Add(imagePart);
                }
            }

            contents.Add(new JsonObject
            {
                ["role"] = "user",
                ["parts"] = parts
            });
        }

        geminiBody["contents"] = contents;

        // ========== generationConfig 组装 ==========
        var generationConfig = new JsonObject();

        // 透传温度 / topP / topK / maxTokens
        if (standardBody.TryGetPropertyValue("temperature", out var temperature))
            generationConfig["temperature"] = temperature?.DeepClone();
        if (standardBody.TryGetPropertyValue("top_p", out var topP))
            generationConfig["topP"] = topP?.DeepClone();
        if (standardBody.TryGetPropertyValue("top_k", out var topK))
            generationConfig["topK"] = topK?.DeepClone();
        if (standardBody.TryGetPropertyValue("max_tokens", out var maxTokens))
            generationConfig["maxOutputTokens"] = maxTokens?.DeepClone();

        // 图像生成：检测是否需要 IMAGE 模态
        var needsImageModality = standardBody.ContainsKey("prompt")
                                  || IsImageGenerationModel(config);

        if (needsImageModality)
        {
            generationConfig["responseModalities"] = new JsonArray { "IMAGE", "TEXT" };

            // 从 OpenAI size 参数推导 Gemini imageConfig
            var size = ReadStringSafe(standardBody["size"]);
            if (!string.IsNullOrEmpty(size))
            {
                var (aspectRatio, imageSize) = ParseSize(size);
                generationConfig["imageConfig"] = new JsonObject
                {
                    ["aspectRatio"] = aspectRatio,
                    ["imageSize"] = imageSize
                };
            }
        }

        // thinkingConfig（供思考型模型使用，config 中配置）
        if (config?.TryGetValue("thinkingLevel", out var thinkingLevel) == true)
        {
            generationConfig["thinkingConfig"] = new JsonObject
            {
                ["thinkingLevel"] = thinkingLevel?.ToString() ?? "MINIMAL"
            };
        }

        if (generationConfig.Count > 0)
            geminiBody["generationConfig"] = generationConfig;

        return geminiBody;
    }

    /// <summary>
    /// Gemini Native 响应 → OpenAI 格式响应
    ///
    /// Gemini 图像响应结构：
    ///   { "candidates": [{ "content": { "parts": [{ "inlineData": {"mimeType":"image/png","data":"base64..."}},
    ///                                              { "text": "..." }] } }] }
    ///
    /// 转成 OpenAI 图像格式：
    ///   { "created": 123, "data": [{ "b64_json": "base64...", "content_type": "image/png" }] }
    ///
    /// Gemini Chat 响应结构：
    ///   { "candidates": [{ "content": { "parts": [{"text":"..."}] } }], "usageMetadata": {...} }
    ///
    /// 转成 OpenAI chat 格式：
    ///   { "id": "...", "choices": [{ "message": { "role":"assistant", "content":"..."} }],
    ///     "usage": { "prompt_tokens": ..., "completion_tokens": ..., "total_tokens": ... } }
    /// </summary>
    public JsonObject TransformResponse(JsonObject rawResponse, Dictionary<string, object>? config)
    {
        var candidates = rawResponse["candidates"] as JsonArray;
        if (candidates == null || candidates.Count == 0)
        {
            // 无 candidate：原样返回便于前端看到错误
            return rawResponse;
        }

        var firstCandidate = candidates[0] as JsonObject;
        var content = firstCandidate?["content"] as JsonObject;
        var parts = content?["parts"] as JsonArray;

        if (parts == null || parts.Count == 0)
        {
            return rawResponse;
        }

        // 扫描 parts：分离图像和文本
        var imageDataArray = new JsonArray();
        var textBuilder = new System.Text.StringBuilder();

        foreach (var partNode in parts)
        {
            if (partNode is not JsonObject partObj) continue;

            // 图像部分（inlineData）
            if (partObj["inlineData"] is JsonObject inlineData)
            {
                var mimeType = ReadStringSafe(inlineData["mimeType"]) ?? "image/png";
                var data = ReadStringSafe(inlineData["data"]);
                if (!string.IsNullOrEmpty(data))
                {
                    imageDataArray.Add(new JsonObject
                    {
                        ["b64_json"] = data,
                        ["content_type"] = mimeType
                    });
                }
            }
            // 文本部分
            else if (partObj["text"] is JsonValue)
            {
                var text = ReadStringSafe(partObj["text"]);
                if (text != null) textBuilder.Append(text);
            }
        }

        // ========== 有图像 → OpenAI 图像响应格式 ==========
        if (imageDataArray.Count > 0)
        {
            var openaiResponse = new JsonObject
            {
                ["created"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                ["data"] = imageDataArray
            };

            if (textBuilder.Length > 0)
                openaiResponse["description"] = textBuilder.ToString();

            return openaiResponse;
        }

        // ========== 仅文本 → OpenAI chat 响应格式 ==========
        var chatResponse = new JsonObject
        {
            ["id"] = $"gemini-{Guid.NewGuid():N}",
            ["object"] = "chat.completion",
            ["created"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            ["choices"] = new JsonArray
            {
                new JsonObject
                {
                    ["index"] = 0,
                    ["message"] = new JsonObject
                    {
                        ["role"] = "assistant",
                        ["content"] = textBuilder.ToString()
                    },
                    ["finish_reason"] = ReadStringSafe(firstCandidate?["finishReason"])?.ToLowerInvariant() ?? "stop"
                }
            }
        };

        // usage 转换
        if (rawResponse["usageMetadata"] is JsonObject usageMeta)
        {
            var promptTokens = ReadIntSafe(usageMeta["promptTokenCount"]);
            var candidatesTokens = ReadIntSafe(usageMeta["candidatesTokenCount"]);
            var totalTokens = ReadIntSafe(usageMeta["totalTokenCount"]);
            if (totalTokens == 0) totalTokens = promptTokens + candidatesTokens;

            chatResponse["usage"] = new JsonObject
            {
                ["prompt_tokens"] = promptTokens,
                ["completion_tokens"] = candidatesTokens,
                ["total_tokens"] = totalTokens
            };
        }

        return chatResponse;
    }

    // ========== 辅助方法 ==========

    /// <summary>
    /// 从 JsonNode 安全读取整数（兼容 int/long/string 三种底层类型）。
    /// Gemini JSON 数字在反序列化为 JsonNode 后底层是 long 或 int，
    /// 直接调用 GetValue&lt;int&gt;() 可能抛 InvalidOperationException。
    /// </summary>
    private static int ReadIntSafe(JsonNode? node)
    {
        if (node is not JsonValue v) return 0;
        if (v.TryGetValue<int>(out var iVal)) return iVal;
        if (v.TryGetValue<long>(out var lVal)) return (int)Math.Min(lVal, int.MaxValue);
        if (v.TryGetValue<string>(out var s) && int.TryParse(s, out var parsed)) return parsed;
        return 0;
    }

    /// <summary>
    /// 从 JsonNode 安全读取字符串，类型不匹配返回 null 而非抛异常。
    /// </summary>
    private static string? ReadStringSafe(JsonNode? node)
    {
        if (node is not JsonValue v) return null;
        return v.TryGetValue<string>(out var s) ? s : v.ToString();
    }

    /// <summary>
    /// 从 JsonNode 提取纯文本内容（支持字符串或 parts 数组）
    /// </summary>
    private static string? ExtractTextContent(JsonNode? node)
    {
        if (node == null) return null;

        if (node is JsonValue)
            return ReadStringSafe(node);

        if (node is JsonArray arr)
        {
            var sb = new System.Text.StringBuilder();
            foreach (var item in arr)
            {
                if (item is JsonObject obj && ReadStringSafe(obj["type"]) == "text")
                {
                    var text = ReadStringSafe(obj["text"]);
                    if (text != null) sb.Append(text);
                }
            }
            return sb.ToString();
        }

        return null;
    }

    /// <summary>
    /// 将 image URL 转成 Gemini 的 part。
    /// - data URI（base64）→ inlineData
    /// - http(s) URL → fileData（Google 要求 fileUri，需用户自行上传）
    ///   对于我们目前主要通过 ConsolidateMultipartToJson 上传的 base64 data URI，走 inlineData。
    /// </summary>
    private static JsonObject? BuildImagePart(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;

        // data URI: "data:image/png;base64,iVBOR..."
        if (url.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var commaIdx = url.IndexOf(',');
            if (commaIdx < 0) return null;

            var metaPart = url.Substring(5, commaIdx - 5); // "image/png;base64"
            var data = url[(commaIdx + 1)..];

            var mimeType = metaPart.Split(';')[0];
            if (string.IsNullOrWhiteSpace(mimeType)) mimeType = "image/png";

            return new JsonObject
            {
                ["inlineData"] = new JsonObject
                {
                    ["mimeType"] = mimeType,
                    ["data"] = data
                }
            };
        }

        // 远程 URL：使用 fileData 字段（需目标支持；Gemini 1.5+ 支持 http fileUri）
        return new JsonObject
        {
            ["fileData"] = new JsonObject
            {
                ["mimeType"] = "image/png",
                ["fileUri"] = url
            }
        };
    }

    /// <summary>
    /// config 中通过 "mode":"image" 或 "responseModalities" 预置图像模式
    /// </summary>
    private static bool IsImageGenerationModel(Dictionary<string, object>? config)
    {
        if (config == null) return false;
        if (config.TryGetValue("mode", out var mode) && mode?.ToString()?.Equals("image", StringComparison.OrdinalIgnoreCase) == true)
            return true;
        return false;
    }

    /// <summary>
    /// OpenAI size "1024x1024" → Gemini (aspectRatio, imageSize)
    /// </summary>
    private static (string aspectRatio, string imageSize) ParseSize(string size)
    {
        var parts = size.Split('x');
        if (parts.Length != 2 ||
            !int.TryParse(parts[0], out var w) ||
            !int.TryParse(parts[1], out var h))
        {
            return ("1:1", "1K");
        }

        var ratio = (double)w / h;
        var aspectRatio = ratio switch
        {
            > 2.0 => "21:9",
            > 1.6 => "16:9",
            > 1.4 => "3:2",
            > 1.2 => "4:3",
            > 1.05 => "5:4",
            > 0.95 => "1:1",
            > 0.75 => "4:5",
            > 0.6 => "3:4",
            > 0.5 => "2:3",
            _ => "9:16"
        };

        var maxDim = Math.Max(w, h);
        var imageSize = maxDim switch
        {
            >= 3840 => "4K",
            >= 1920 => "2K",
            _ => "1K"
        };

        return (aspectRatio, imageSize);
    }
}
