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
    /// </summary>
    public string? ExpectedModel { get; init; }

    /// <summary>
    /// 请求体（JSON 格式）
    /// Gateway 会自动替换其中的 "model" 字段
    /// </summary>
    public JsonObject? RequestBody { get; init; }

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
/// 图片生成专用请求扩展
/// </summary>
public class ImageGenGatewayRequest : GatewayRequest
{
    /// <summary>
    /// 提示词
    /// </summary>
    public required string Prompt { get; init; }

    /// <summary>
    /// 生成数量
    /// </summary>
    public int N { get; init; } = 1;

    /// <summary>
    /// 尺寸（如 1024x1024）
    /// </summary>
    public string? Size { get; init; }

    /// <summary>
    /// 响应格式（url 或 b64_json）
    /// </summary>
    public string? ResponseFormat { get; init; }

    /// <summary>
    /// 参考图 Base64（用于 img2img）
    /// </summary>
    public string? InitImageBase64 { get; init; }

    /// <summary>
    /// 多图参考列表（用于 Vision API 生图）
    /// </summary>
    public List<ImageRefItem>? ImageRefs { get; init; }

    /// <summary>
    /// 应用标识（用于水印配置）
    /// </summary>
    public string? AppKey { get; init; }
}

/// <summary>
/// 图片参考项
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
