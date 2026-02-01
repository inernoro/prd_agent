using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// LLM Gateway 统一请求模型
/// 所有大模型调用都必须通过此结构传入
/// </summary>
public class GatewayRequest
{
    /// <summary>
    /// 应用调用标识（必填）
    /// 用于确定模型池绑定、权限控制、日志分类
    /// 例如: "visual-agent.image.vision::generation"
    /// </summary>
    public required string AppCallerCode { get; init; }

    /// <summary>
    /// 模型类型（必填）
    /// chat / vision / generation / intent / embedding / rerank / long-context / code
    /// </summary>
    public required string ModelType { get; init; }

    /// <summary>
    /// 期望的模型名称（可选）
    /// 仅作为调度提示，实际使用的模型由调度器决定
    /// 会记录在日志中用于分析期望与实际的差异
    /// 如果不提供，会自动从 RequestBody["model"] 中提取
    /// </summary>
    public string? ExpectedModel { get; init; }

    /// <summary>
    /// 请求体（JSON 格式）
    /// Gateway 会自动替换其中的 "model" 字段
    /// </summary>
    public JsonObject? RequestBody { get; init; }

    /// <summary>
    /// 获取有效的期望模型名称
    /// 优先级：ExpectedModel > RequestBody["model"] > RequestBodyRaw["model"]
    /// </summary>
    public string? GetEffectiveExpectedModel()
    {
        // 1. 显式指定的 ExpectedModel 优先
        if (!string.IsNullOrWhiteSpace(ExpectedModel))
            return ExpectedModel.Trim();

        // 2. 从 RequestBody 提取
        if (RequestBody != null &&
            RequestBody.TryGetPropertyValue("model", out var modelNode) &&
            modelNode != null)
        {
            var model = modelNode.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(model))
                return model.Trim();
        }

        // 3. 从 RequestBodyRaw 提取
        if (!string.IsNullOrWhiteSpace(RequestBodyRaw))
        {
            try
            {
                var parsed = JsonNode.Parse(RequestBodyRaw);
                if (parsed is JsonObject obj &&
                    obj.TryGetPropertyValue("model", out var rawModelNode) &&
                    rawModelNode != null)
                {
                    var model = rawModelNode.GetValue<string>();
                    if (!string.IsNullOrWhiteSpace(model))
                        return model.Trim();
                }
            }
            catch
            {
                // 解析失败忽略
            }
        }

        return null;
    }

    /// <summary>
    /// 请求体原始 JSON 字符串（与 RequestBody 二选一）
    /// 如果同时提供，优先使用 RequestBody
    /// </summary>
    public string? RequestBodyRaw { get; init; }

    /// <summary>
    /// 是否启用流式响应
    /// </summary>
    public bool Stream { get; init; } = false;

    /// <summary>
    /// 是否启用 Prompt Cache（仅部分平台支持）
    /// </summary>
    public bool EnablePromptCache { get; init; } = false;

    /// <summary>
    /// 请求超时（秒）
    /// 默认 120 秒，图片生成建议 600 秒
    /// </summary>
    public int TimeoutSeconds { get; init; } = 120;

    /// <summary>
    /// 额外的请求上下文（可选）
    /// 用于日志记录的补充信息
    /// </summary>
    public GatewayRequestContext? Context { get; init; }

    /// <summary>
    /// 获取有效的请求体 JsonObject
    /// </summary>
    public JsonObject GetEffectiveRequestBody()
    {
        if (RequestBody != null)
            return RequestBody;

        if (!string.IsNullOrWhiteSpace(RequestBodyRaw))
        {
            try
            {
                var parsed = JsonNode.Parse(RequestBodyRaw);
                if (parsed is JsonObject obj)
                    return obj;
            }
            catch
            {
                // 解析失败返回空对象
            }
        }

        return new JsonObject();
    }
}

/// <summary>
/// 请求上下文（用于日志和追踪）
/// </summary>
public class GatewayRequestContext
{
    /// <summary>
    /// 请求 ID（用于关联日志）
    /// </summary>
    public string? RequestId { get; init; }

    /// <summary>
    /// 会话 ID
    /// </summary>
    public string? SessionId { get; init; }

    /// <summary>
    /// 用户组 ID
    /// </summary>
    public string? GroupId { get; init; }

    /// <summary>
    /// 用户 ID
    /// </summary>
    public string? UserId { get; init; }

    /// <summary>
    /// 查看角色
    /// </summary>
    public string? ViewRole { get; init; }

    /// <summary>
    /// 文档字符数
    /// </summary>
    public int? DocumentChars { get; init; }

    /// <summary>
    /// 文档哈希
    /// </summary>
    public string? DocumentHash { get; init; }

    /// <summary>
    /// 问题文本（用于日志摘要）
    /// </summary>
    public string? QuestionText { get; init; }

    /// <summary>
    /// 系统提示词字符数
    /// </summary>
    public int? SystemPromptChars { get; init; }

    /// <summary>
    /// 系统提示词文本（用于日志）
    /// </summary>
    public string? SystemPromptText { get; init; }
}

/// <summary>
/// 原始 HTTP 请求（用于图片生成等复杂场景）
/// Gateway 负责：模型调度 + model 字段替换 + HTTP 发送 + 日志 + 健康管理
/// 调用方负责：构建请求体（业务逻辑如尺寸适配、水印等）
/// </summary>
public class GatewayRawRequest
{
    /// <summary>
    /// 应用调用标识（必填）
    /// </summary>
    public required string AppCallerCode { get; init; }

    /// <summary>
    /// 模型类型（必填）：generation / vision / chat / intent
    /// </summary>
    public required string ModelType { get; init; }

    /// <summary>
    /// 自定义 endpoint 路径（如 "/v1/images/generations"）
    /// 如果不指定，使用平台默认的 endpoint
    /// </summary>
    public string? EndpointPath { get; init; }

    /// <summary>
    /// 请求体（JSON 格式）
    /// Gateway 会替换其中的 "model" 字段为实际调度的模型
    /// </summary>
    public JsonObject? RequestBody { get; init; }

    /// <summary>
    /// 是否为 multipart/form-data 请求（如 img2img）
    /// </summary>
    public bool IsMultipart { get; init; }

    /// <summary>
    /// multipart 表单数据（如果 IsMultipart = true）
    /// Gateway 会在其中添加 "model" 字段
    /// </summary>
    public Dictionary<string, object>? MultipartFields { get; init; }

    /// <summary>
    /// multipart 文件数据
    /// Key: 字段名, Value: (文件名, 内容, MIME类型)
    /// </summary>
    public Dictionary<string, (string FileName, byte[] Content, string MimeType)>? MultipartFiles { get; init; }

    /// <summary>
    /// HTTP 方法（默认 POST）
    /// </summary>
    public string HttpMethod { get; init; } = "POST";

    /// <summary>
    /// 额外的请求头
    /// </summary>
    public Dictionary<string, string>? ExtraHeaders { get; init; }

    /// <summary>
    /// 请求超时（秒），图片生成建议 600
    /// </summary>
    public int TimeoutSeconds { get; init; } = 120;

    /// <summary>
    /// 请求上下文（用于日志）
    /// </summary>
    public GatewayRequestContext? Context { get; init; }
}

/// <summary>
/// 原始 HTTP 响应
/// </summary>
public class GatewayRawResponse
{
    /// <summary>
    /// 是否成功
    /// </summary>
    public bool Success { get; init; }

    /// <summary>
    /// HTTP 状态码
    /// </summary>
    public int StatusCode { get; init; }

    /// <summary>
    /// 响应内容（原始字符串）
    /// </summary>
    public string? Content { get; init; }

    /// <summary>
    /// 响应头
    /// </summary>
    public Dictionary<string, string>? ResponseHeaders { get; init; }

    /// <summary>
    /// 错误码
    /// </summary>
    public string? ErrorCode { get; init; }

    /// <summary>
    /// 错误消息
    /// </summary>
    public string? ErrorMessage { get; init; }

    /// <summary>
    /// 模型调度信息
    /// </summary>
    public GatewayModelResolution? Resolution { get; init; }

    /// <summary>
    /// 请求耗时（毫秒）
    /// </summary>
    public long DurationMs { get; init; }

    /// <summary>
    /// 日志 ID
    /// </summary>
    public string? LogId { get; init; }

    public static GatewayRawResponse Fail(string errorCode, string errorMessage, int statusCode = 500)
    {
        return new GatewayRawResponse
        {
            Success = false,
            ErrorCode = errorCode,
            ErrorMessage = errorMessage,
            StatusCode = statusCode
        };
    }
}

/// <summary>
/// 图片参考项（用于多图 Vision 生图）
/// </summary>
public class ImageRefItem
{
    public int RefId { get; init; }
    public string Label { get; init; } = string.Empty;
    public string Role { get; init; } = string.Empty;
    public string Base64 { get; init; } = string.Empty;
    public string MimeType { get; init; } = "image/png";
    public string? Sha256 { get; init; }
    public string? CosUrl { get; init; }
}
