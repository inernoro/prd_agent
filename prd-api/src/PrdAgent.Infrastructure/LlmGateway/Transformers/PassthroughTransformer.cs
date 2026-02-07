using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway.Transformers;

/// <summary>
/// 透传转换器 - 不做任何转换，直接透传请求/响应
/// 适用于已经兼容目标格式的场景
/// </summary>
public class PassthroughTransformer : IExchangeTransformer
{
    public string TransformerType => "passthrough";

    public JsonObject TransformRequest(JsonObject standardBody, Dictionary<string, object>? config)
    {
        return standardBody;
    }

    public JsonObject TransformResponse(JsonObject rawResponse, Dictionary<string, object>? config)
    {
        return rawResponse;
    }
}
