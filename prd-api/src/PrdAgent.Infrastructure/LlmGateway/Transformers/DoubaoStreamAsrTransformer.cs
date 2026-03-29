using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway.Transformers;

/// <summary>
/// 豆包流式 ASR 转换器（WebSocket 二进制协议标记）
///
/// 此转换器为标记类型，实际的 WebSocket 通信由 DoubaoStreamAsrService 处理。
/// Exchange 系统中注册此类型，使其出现在转换器列表中，
/// 但 HTTP 管线不会使用 TransformRequest/TransformResponse。
///
/// TransformerConfig 字段：
/// - wsUrl: WebSocket URL（默认 wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream）
/// - resourceId: 资源 ID（默认 "volc.bigasr.sauc.duration"）
/// - enableItn / enablePunc / enableDdc: 识别参数
/// </summary>
public class DoubaoStreamAsrTransformer : IExchangeTransformer
{
    public string TransformerType => "doubao-asr-stream";

    public string? ResolveTargetUrl(string baseUrl, JsonObject standardBody, Dictionary<string, object>? config)
    {
        return null;
    }

    public Dictionary<string, string>? GetExtraHeaders(Dictionary<string, object>? config)
    {
        var resourceId = config?.GetValueOrDefault("resourceId")?.ToString() ?? "volc.bigasr.sauc.duration";
        return new Dictionary<string, string>
        {
            ["X-Api-Resource-Id"] = resourceId,
            ["X-Api-Request-Id"] = Guid.NewGuid().ToString(),
            ["X-Api-App-Key"] = config?.GetValueOrDefault("appKey")?.ToString() ?? ""
        };
    }

    /// <summary>
    /// 标准请求 → 透传（WebSocket 模式不走 HTTP 管线）
    /// </summary>
    public JsonObject TransformRequest(JsonObject standardBody, Dictionary<string, object>? config)
    {
        return standardBody;
    }

    /// <summary>
    /// 响应 → 透传（WebSocket 模式下不走此路径）
    /// </summary>
    public JsonObject TransformResponse(JsonObject rawResponse, Dictionary<string, object>? config)
    {
        return rawResponse;
    }
}
