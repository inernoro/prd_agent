using System.Text.Json.Nodes;

namespace PrdAgent.Infrastructure.LlmGateway.Adapters;

/// <summary>
/// Gateway 平台适配器接口
/// 负责处理不同 LLM 平台的请求格式差异
/// </summary>
public interface IGatewayAdapter
{
    /// <summary>
    /// 平台类型标识（如 openai, claude, azure）
    /// </summary>
    string PlatformType { get; }

    /// <summary>
    /// 构建 API 端点 URL
    /// </summary>
    /// <param name="apiBase">平台 API 基础 URL</param>
    /// <param name="modelType">模型类型</param>
    /// <returns>完整端点 URL</returns>
    string BuildEndpoint(string apiBase, string modelType);

    /// <summary>
    /// 构建 HTTP 请求
    /// </summary>
    /// <param name="endpoint">端点 URL</param>
    /// <param name="apiKey">API 密钥</param>
    /// <param name="requestBody">请求体</param>
    /// <param name="enablePromptCache">是否启用 Prompt Cache</param>
    /// <returns>HTTP 请求消息</returns>
    HttpRequestMessage BuildHttpRequest(
        string endpoint,
        string? apiKey,
        JsonObject requestBody,
        bool enablePromptCache = false);

    /// <summary>
    /// 解析流式响应块
    /// </summary>
    /// <param name="sseData">SSE data 字段内容</param>
    /// <returns>解析后的响应块</returns>
    GatewayStreamChunk? ParseStreamChunk(string sseData);

    /// <summary>
    /// 从响应体解析 Token 使用量
    /// </summary>
    /// <param name="responseBody">响应体 JSON</param>
    /// <returns>Token 使用量</returns>
    GatewayTokenUsage? ParseTokenUsage(string responseBody);

    /// <summary>
    /// 从非流式响应体中提取消息文本内容
    /// OpenAI: choices[0].message.content
    /// Claude: content[0].text
    /// </summary>
    /// <param name="responseBody">响应体 JSON</param>
    /// <returns>提取的文本内容，失败返回 null（回退到原始 JSON）</returns>
    string? ParseMessageContent(string responseBody);
}
