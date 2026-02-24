using System.Text.Json.Nodes;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Exchange 转换器接口
/// 负责在标准格式（OpenAI）和非标准格式（如 fal.ai）之间转换请求/响应
/// </summary>
public interface IExchangeTransformer
{
    /// <summary>
    /// 转换器类型标识（如 "fal-image", "passthrough"）
    /// </summary>
    string TransformerType { get; }

    /// <summary>
    /// 根据请求内容解析实际目标 URL（智能路由）。
    /// 返回 null 表示使用 Exchange 配置中的原始 TargetUrl。
    /// </summary>
    /// <param name="baseUrl">Exchange 配置中的 TargetUrl（基础 URL）</param>
    /// <param name="standardBody">标准 OpenAI 格式的请求体</param>
    /// <param name="config">转换器配置（可选）</param>
    /// <returns>实际目标 URL，null 则使用 baseUrl</returns>
    string? ResolveTargetUrl(string baseUrl, JsonObject standardBody, Dictionary<string, object>? config);

    /// <summary>
    /// 转换请求：标准格式 → 目标格式
    /// </summary>
    JsonObject TransformRequest(JsonObject standardBody, Dictionary<string, object>? config);

    /// <summary>
    /// 转换响应：目标格式 → 标准格式
    /// </summary>
    JsonObject TransformResponse(JsonObject rawResponse, Dictionary<string, object>? config);
}
