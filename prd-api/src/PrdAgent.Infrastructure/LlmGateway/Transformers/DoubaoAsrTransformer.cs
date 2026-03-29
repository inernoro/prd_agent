using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway.Transformers;

/// <summary>
/// 豆包 (ByteDance) 大模型语音识别转换器 — 异步 submit+query 模式
///
/// 流程：
/// 1. submit → POST /api/v3/auc/bigmodel/submit 提交转录任务
/// 2. query  → POST /api/v3/auc/bigmodel/query  轮询结果
/// 3. 状态码通过 X-Api-Status-Code 响应头返回：
///    - 20000000: 完成
///    - 20000001 / 20000002: 处理中
///    - 其他: 失败
///
/// TransformerConfig 字段：
/// - resourceId: 资源 ID（默认 "volc.bigasr.auc"）
/// - enableItn: 启用 ITN 反标准化（默认 true）
/// - enablePunc: 启用标点（默认 true）
/// - enableDdc: 启用 DDC 顺滑（默认 true）
/// - enableSpeakerInfo: 启用说话人信息（默认 true）
/// - enableChannelSplit: 启用声道分离（默认 true）
///
/// 认证方式支持两种：
/// - DoubaoAsr: apiKey 格式 "appId|accessToken" → X-Api-App-Key + X-Api-Access-Key
/// - XApiKey: 单一 key → x-api-key
/// </summary>
public class DoubaoAsrTransformer : IAsyncExchangeTransformer
{
    public string TransformerType => "doubao-asr";
    public int PollIntervalMs => 1000;
    public int MaxPollAttempts => 600; // 最多 10 分钟

    /// <summary>
    /// submit URL 固定，不做路由
    /// </summary>
    public string? ResolveTargetUrl(string baseUrl, JsonObject standardBody, Dictionary<string, object>? config)
    {
        return null;
    }

    /// <summary>
    /// 获取额外请求头：X-Api-Resource-Id、X-Api-Request-Id、X-Api-Sequence
    /// </summary>
    public Dictionary<string, string>? GetExtraHeaders(Dictionary<string, object>? config)
    {
        var resourceId = GetConfigString(config, "resourceId") ?? "volc.bigasr.auc";
        return new Dictionary<string, string>
        {
            ["X-Api-Resource-Id"] = resourceId,
            ["X-Api-Request-Id"] = Guid.NewGuid().ToString(),
            ["X-Api-Sequence"] = "-1"
        };
    }

    /// <summary>
    /// 标准请求 → 豆包 submit 请求
    ///
    /// 输入: { "audio_url": "https://...", "audio_data": "base64...", "language": "zh" }
    /// 输出: { "user": { "uid": "..." }, "audio": { "url": "..." }, "request": { "model_name": "bigmodel", ... } }
    /// </summary>
    public JsonObject TransformRequest(JsonObject standardBody, Dictionary<string, object>? config)
    {
        // 构建 audio
        var audio = new JsonObject();
        if (TryGetString(standardBody, "audio_url", out var audioUrl))
            audio["url"] = audioUrl;
        else if (TryGetString(standardBody, "audio_data", out var audioData))
            audio["data"] = audioData;
        else if (TryGetString(standardBody, "url", out var fallbackUrl))
            audio["url"] = fallbackUrl;

        // 可选 audio 参数
        if (TryGetString(standardBody, "format", out var format))
            audio["format"] = format;

        // 构建 request
        var requestObj = new JsonObject { ["model_name"] = "bigmodel" };

        requestObj["enable_itn"] = GetConfigBool(config, "enableItn", true);
        requestObj["enable_punc"] = GetConfigBool(config, "enablePunc", true);
        requestObj["enable_ddc"] = GetConfigBool(config, "enableDdc", true);
        requestObj["enable_speaker_info"] = GetConfigBool(config, "enableSpeakerInfo", true);
        requestObj["enable_channel_split"] = GetConfigBool(config, "enableChannelSplit", true);

        // 语言（可选）
        if (TryGetString(standardBody, "language", out var lang) && !string.IsNullOrWhiteSpace(lang))
            requestObj["language"] = lang;

        var uid = GetConfigString(config, "uid") ?? "prd-agent";

        return new JsonObject
        {
            ["user"] = new JsonObject { ["uid"] = uid },
            ["audio"] = audio,
            ["request"] = requestObj
        };
    }

    /// <summary>
    /// 豆包最终响应 → Whisper 兼容格式
    ///
    /// 豆包返回: { "result": [{ "text": "...", "additions": { "duration": "..." } }] }
    /// 转换为: { "text": "完整文本", "segments": [...], "language": "zh" }
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
                    duration /= 1000.0; // 毫秒 → 秒
                }

                if (!string.IsNullOrWhiteSpace(text))
                {
                    fullText += text;
                    segments.Add(new JsonObject
                    {
                        ["start"] = currentStart,
                        ["end"] = currentStart + duration,
                        ["text"] = text
                    });
                    currentStart += duration;
                }
            }
        }

        // 兜底：如果 result 不是数组而是包含 text 字段的对象
        if (segments.Count == 0 && rawResponse.TryGetPropertyValue("text", out var directText))
        {
            fullText = directText?.GetValue<string>() ?? "";
        }

        response["text"] = fullText;
        response["segments"] = segments;
        response["language"] = "zh";

        return response;
    }

    // ═══════════════════════════════════════════════════════════
    // IAsyncExchangeTransformer — 异步轮询
    // ═══════════════════════════════════════════════════════════

    /// <summary>
    /// X-Api-Status-Code: 20000001 或 20000002 表示处理中
    /// </summary>
    public bool IsTaskPending(int httpStatus, Dictionary<string, string> responseHeaders, string? responseBody)
    {
        var code = GetStatusCode(responseHeaders);
        return code == "20000001" || code == "20000002";
    }

    /// <summary>
    /// X-Api-Status-Code: 20000000 表示完成
    /// </summary>
    public bool IsTaskComplete(int httpStatus, Dictionary<string, string> responseHeaders, string? responseBody)
    {
        return GetStatusCode(responseHeaders) == "20000000";
    }

    /// <summary>
    /// 非 20000000/20000001/20000002 表示失败
    /// </summary>
    public bool IsTaskFailed(int httpStatus, Dictionary<string, string> responseHeaders, string? responseBody, out string errorMessage)
    {
        var code = GetStatusCode(responseHeaders);
        if (string.IsNullOrEmpty(code))
        {
            errorMessage = $"豆包 ASR 响应缺少 X-Api-Status-Code header, HTTP {httpStatus}";
            return true;
        }
        if (code == "20000000" || code == "20000001" || code == "20000002")
        {
            errorMessage = "";
            return false;
        }

        var message = responseHeaders.GetValueOrDefault("X-Api-Message") ?? "未知错误";
        errorMessage = $"豆包 ASR 失败: code={code}, message={message}";
        return true;
    }

    /// <summary>
    /// 构建 query 请求：
    /// - URL: 同域名下的 /query 端点
    /// - Headers: 保留认证头 + 传递 submit 返回的 X-Tt-Logid
    /// - Body: 空对象
    /// </summary>
    public (string queryUrl, JsonObject? queryBody, Dictionary<string, string> queryHeaders) BuildQueryRequest(
        string baseUrl,
        int submitHttpStatus,
        Dictionary<string, string> submitResponseHeaders,
        string? submitResponseBody,
        Dictionary<string, object>? config)
    {
        // submit URL: .../submit → query URL: .../query
        var queryUrl = baseUrl.Replace("/submit", "/query");

        var queryHeaders = new Dictionary<string, string>();

        // 传递 X-Tt-Logid（豆包要求 query 时携带）
        if (submitResponseHeaders.TryGetValue("X-Tt-Logid", out var logId))
            queryHeaders["X-Tt-Logid"] = logId;

        // Resource ID
        var resourceId = GetConfigString(config, "resourceId") ?? "volc.bigasr.auc";
        queryHeaders["X-Api-Resource-Id"] = resourceId;

        return (queryUrl, new JsonObject(), queryHeaders);
    }

    // ═══════════════════════════════════════════════════════════
    // 工具方法
    // ═══════════════════════════════════════════════════════════

    private static string? GetStatusCode(Dictionary<string, string> headers)
    {
        return headers.GetValueOrDefault("X-Api-Status-Code");
    }

    private static bool TryGetString(JsonObject obj, string key, out string value)
    {
        if (obj.TryGetPropertyValue(key, out var node) && node != null)
        {
            value = node.GetValue<string>();
            return !string.IsNullOrEmpty(value);
        }
        value = "";
        return false;
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
