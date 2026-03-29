using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway.Transformers;

/// <summary>
/// 豆包 (ByteDance) 大模型语音识别转换器
/// 将标准 OpenAI Whisper 格式 ↔ 豆包 bigmodel/recognize/flash 格式
///
/// 豆包 API 特点：
/// - URL: https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
/// - 认证: X-Api-App-Key (appId) + X-Api-Access-Key (accessToken)
/// - 请求: { user: { uid }, audio: { url | data }, request: { model_name } }
/// - 响应: 通过 header X-Api-Status-Code 判断，body 含识别结果
///
/// TransformerConfig 可选字段：
/// - appId: 豆包 App ID（如不通过 config 传，则使用 TargetApiKey 作为 accessToken）
/// - resourceId: 资源 ID（默认 "volc.bigasr.auc_turbo"）
/// - enableItn: 是否启用 ITN 反标准化（默认 true）
/// - enablePunc: 是否启用标点（默认 true）
/// - enableDdc: 是否启用 DDC 顺滑（默认 true）
/// </summary>
public class DoubaoAsrTransformer : IExchangeTransformer
{
    public string TransformerType => "doubao-asr";

    public string? ResolveTargetUrl(string baseUrl, JsonObject standardBody, Dictionary<string, object>? config)
    {
        // 固定使用配置的 URL
        return null;
    }

    /// <summary>
    /// OpenAI Whisper 格式 → 豆包 ASR 格式
    ///
    /// 标准输入（简化版，非 multipart 场景）:
    /// { "audio_url": "https://...", "audio_data": "base64...", "language": "zh" }
    ///
    /// 豆包输出:
    /// { "user": { "uid": "..." }, "audio": { "url": "..." | "data": "..." }, "request": { "model_name": "bigmodel", ... } }
    /// </summary>
    public JsonObject TransformRequest(JsonObject standardBody, Dictionary<string, object>? config)
    {
        var appId = GetConfigString(config, "appId") ?? "default";

        // 构建 audio 部分
        var audio = new JsonObject();
        if (standardBody.TryGetPropertyValue("audio_url", out var urlNode) && urlNode != null)
        {
            audio["url"] = urlNode.GetValue<string>();
        }
        else if (standardBody.TryGetPropertyValue("audio_data", out var dataNode) && dataNode != null)
        {
            audio["data"] = dataNode.GetValue<string>();
        }
        else if (standardBody.TryGetPropertyValue("url", out var fallbackUrl) && fallbackUrl != null)
        {
            audio["url"] = fallbackUrl.GetValue<string>();
        }

        // 构建 request 部分
        var requestObj = new JsonObject
        {
            ["model_name"] = "bigmodel"
        };

        var enableItn = GetConfigBool(config, "enableItn", true);
        var enablePunc = GetConfigBool(config, "enablePunc", true);
        var enableDdc = GetConfigBool(config, "enableDdc", true);

        if (enableItn) requestObj["enable_itn"] = true;
        if (enablePunc) requestObj["enable_punc"] = true;
        if (enableDdc) requestObj["enable_ddc"] = true;

        // 语言设置（可选）
        if (standardBody.TryGetPropertyValue("language", out var lang) && lang != null)
        {
            var langStr = lang.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(langStr))
                requestObj["language"] = langStr;
        }

        var result = new JsonObject
        {
            ["user"] = new JsonObject { ["uid"] = appId },
            ["audio"] = audio,
            ["request"] = requestObj
        };

        return result;
    }

    /// <summary>
    /// 豆包 ASR 响应 → OpenAI Whisper verbose_json 兼容格式
    ///
    /// 豆包返回格式:
    /// { "result": [{ "text": "...", "additions": { "duration": "..." } }] }
    ///
    /// 转换为:
    /// { "text": "完整文本", "segments": [{ "start": 0, "end": ..., "text": "..." }], "language": "zh" }
    /// </summary>
    public JsonObject TransformResponse(JsonObject rawResponse, Dictionary<string, object>? config)
    {
        var response = new JsonObject();
        var fullText = "";
        var segments = new JsonArray();

        if (rawResponse.TryGetPropertyValue("result", out var resultNode) && resultNode is JsonArray resultArr)
        {
            double currentStart = 0;
            foreach (var item in resultArr)
            {
                if (item is not JsonObject itemObj) continue;

                var text = "";
                if (itemObj.TryGetPropertyValue("text", out var textNode))
                    text = textNode?.GetValue<string>() ?? "";

                double duration = 0;
                if (itemObj.TryGetPropertyValue("additions", out var additionsNode) &&
                    additionsNode is JsonObject additions &&
                    additions.TryGetPropertyValue("duration", out var durNode))
                {
                    var durStr = durNode?.GetValue<string>() ?? "0";
                    double.TryParse(durStr, out duration);
                    // 豆包 duration 单位是毫秒，转换为秒
                    duration /= 1000.0;
                }

                if (!string.IsNullOrWhiteSpace(text))
                {
                    fullText += text;
                    var segment = new JsonObject
                    {
                        ["start"] = currentStart,
                        ["end"] = currentStart + duration,
                        ["text"] = text
                    };
                    segments.Add(segment);
                    currentStart += duration;
                }
            }
        }

        response["text"] = fullText;
        response["segments"] = segments;
        response["language"] = "zh";

        return response;
    }

    private static string? GetConfigString(Dictionary<string, object>? config, string key)
    {
        if (config == null) return null;
        if (config.TryGetValue(key, out var val))
            return val?.ToString();
        return null;
    }

    private static bool GetConfigBool(Dictionary<string, object>? config, string key, bool defaultValue)
    {
        if (config == null) return defaultValue;
        if (!config.TryGetValue(key, out var val)) return defaultValue;
        if (val is bool b) return b;
        if (val is string s && bool.TryParse(s, out var parsed)) return parsed;
        return defaultValue;
    }
}
