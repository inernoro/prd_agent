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

    /// <summary>
    /// 获取此转换器需要附加的额外 HTTP 请求头。
    /// 用于非标准认证（如豆包 ASR 的 X-Api-Resource-Id）。
    /// 返回 null 表示无额外 header。
    /// </summary>
    Dictionary<string, string>? GetExtraHeaders(Dictionary<string, object>? config) => null;
}

/// <summary>
/// 异步 Exchange 转换器接口（submit + query 轮询模式）
/// 用于目标 API 采用异步任务模式的场景（如豆包大模型 ASR）。
///
/// 流程：
/// 1. Gateway 发送 submit 请求（TransformRequest 转换后的 body）
/// 2. 检查 submit 响应是否需要轮询（IsTaskPending）
/// 3. 如需轮询，构建 query 请求（BuildQueryRequest）并循环调用
/// 4. 直到 IsTaskComplete 或 IsTaskFailed，最后用 TransformResponse 转换最终结果
/// </summary>
public interface IAsyncExchangeTransformer : IExchangeTransformer
{
    /// <summary>轮询间隔（毫秒）</summary>
    int PollIntervalMs => 1000;

    /// <summary>最大轮询次数（超过后视为超时）</summary>
    int MaxPollAttempts => 300;

    /// <summary>
    /// 判断 submit/query 响应是否表示任务仍在处理中。
    /// 返回 true 则继续轮询。
    /// </summary>
    bool IsTaskPending(int httpStatus, Dictionary<string, string> responseHeaders, string? responseBody);

    /// <summary>
    /// 判断任务是否已完成（成功）。
    /// </summary>
    bool IsTaskComplete(int httpStatus, Dictionary<string, string> responseHeaders, string? responseBody);

    /// <summary>
    /// 判断任务是否失败，返回错误信息。
    /// </summary>
    bool IsTaskFailed(int httpStatus, Dictionary<string, string> responseHeaders, string? responseBody, out string errorMessage);

    /// <summary>
    /// 从 submit 响应中构建 query 请求。
    /// 返回 (queryUrl, queryBody, queryExtraHeaders)。
    /// </summary>
    (string queryUrl, JsonObject? queryBody, Dictionary<string, string> queryHeaders) BuildQueryRequest(
        string baseUrl,
        int submitHttpStatus,
        Dictionary<string, string> submitResponseHeaders,
        string? submitResponseBody,
        Dictionary<string, object>? config);
}
