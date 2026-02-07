using System.Text.Json.Nodes;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Exchange 转换器接口
/// 负责在标准格式（OpenAI）和非标准格式（如 fal.ai）之间转换请求/响应
/// </summary>
public interface IExchangeTransformer
{
    /// <summary>
    /// 转换器类型标识（如 "fal-image-edit", "passthrough"）
    /// </summary>
    string TransformerType { get; }

    /// <summary>
    /// 转换请求：标准格式 → 目标格式
    /// </summary>
    /// <param name="standardBody">标准 OpenAI 格式的请求体</param>
    /// <param name="config">转换器配置（可选）</param>
    /// <returns>转换后的请求体</returns>
    JsonObject TransformRequest(JsonObject standardBody, Dictionary<string, object>? config);

    /// <summary>
    /// 转换响应：目标格式 → 标准格式
    /// </summary>
    /// <param name="rawResponse">目标 API 返回的原始响应</param>
    /// <param name="config">转换器配置（可选）</param>
    /// <returns>标准 OpenAI 格式的响应</returns>
    JsonObject TransformResponse(JsonObject rawResponse, Dictionary<string, object>? config);
}
