using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway.Transformers;

/// <summary>
/// 豆包流式 ASR 转换器（WebSocket 二进制协议标记）。
///
/// HTTP Exchange 的普通 TransformRequest/TransformResponse 管线不承载 WebSocket；
/// LlmGateway.SendRawWithResolutionAsync 会识别此 TransformerType，并在网关内部执行
/// DoubaoStreamAsrService。Mode=http 时该执行发生在 llmgw-serve 进程内，MAP 只提交
/// GatewayRawRequest，不再直接连接豆包上游。
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
