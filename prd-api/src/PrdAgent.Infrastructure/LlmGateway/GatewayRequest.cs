using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Core.Models;

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
    /// 精确锁定的平台 ID。与 <see cref="PinnedModelId"/> 同时提供时，Resolver 只允许命中该平台该模型。
    /// 用于 ModelLab/Arena 等“选 A 必须测 A”的场景，避免绕过网关日志、配额和 transport 观测。
    /// </summary>
    public string? PinnedPlatformId { get; init; }

    /// <summary>
    /// 精确锁定的模型 ID/名称。与 <see cref="PinnedPlatformId"/> 同时提供时禁止默认池重排。
    /// </summary>
    public string? PinnedModelId { get; init; }

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
    /// 是否在流式响应中包含思考过程（reasoning_content）
    /// 默认 false（过滤思考内容，仅记录日志）
    /// 设为 true 时，思考块将作为 GatewayChunkType.Thinking 传递给调用方。
    /// 注意：Intent 模型类型强制 IncludeThinking=false，无论此值如何设置。
    /// </summary>
    public bool IncludeThinking { get; init; } = false;

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

    /// <summary>
    /// 图片引用列表（参考图 COS URL 等元数据，用于日志页展示）
    /// </summary>
    public List<LlmImageReference>? ImageReferences { get; init; }

    /// <summary>
    /// 网关传输路径观测标记（S2）：inproc / http / shadow / direct。
    /// http 模式下由 MAP 侧 HttpLlmGatewayClient 置 "http" 后随请求体过线，serving 端 OpenContextScope
    /// 将其注入 LlmRequestContext，供 serving 的 LlmGateway 权威标注该条日志的传输通道。
    /// 为 null 时 serving 端 LlmGateway 兜底为 inproc。
    /// </summary>
    public string? GatewayTransport { get; init; }

    /// <summary>
    /// 返回一份把 <see cref="GatewayTransport"/> 覆盖为指定值的副本（其余字段原样拷贝）。
    /// <paramref name="source"/> 为 null 时新建一个仅含传输标记的最小上下文。
    /// 用于 http 模式过线前给请求体的 Context 打上 "http" 传输标记（S2 观测）。
    /// </summary>
    public static GatewayRequestContext WithTransport(GatewayRequestContext? source, string transport)
        => new()
        {
            RequestId = source?.RequestId,
            SessionId = source?.SessionId,
            GroupId = source?.GroupId,
            UserId = source?.UserId,
            ViewRole = source?.ViewRole,
            DocumentChars = source?.DocumentChars,
            DocumentHash = source?.DocumentHash,
            QuestionText = source?.QuestionText,
            SystemPromptChars = source?.SystemPromptChars,
            SystemPromptText = source?.SystemPromptText,
            ImageReferences = source?.ImageReferences,
            GatewayTransport = transport,
        };
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
    /// 期望使用的模型名称（可选）。
    /// 由调用方在第一次 Resolve 后将 resolution.ActualModel 传入，
    /// Gateway 在内部 Resolve 时直接透传，防止二次 Resolve 选出不同模型。
    /// </summary>
    public string? ExpectedModel { get; init; }

    /// <summary>
    /// 精确锁定的平台 ID。与 <see cref="PinnedModelId"/> 同时提供时，raw 调用也只走该平台该模型。
    /// </summary>
    public string? PinnedPlatformId { get; init; }

    /// <summary>
    /// 精确锁定的模型 ID/名称。用于跨进程 raw 调用保持“选 A 用 A”。
    /// </summary>
    public string? PinnedModelId { get; init; }

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
    /// multipart 文件的"对象存储引用"形态（网关物理独立后跨 HTTP 边界用）。
    /// 大负载（音/视频 ASR 输入，数 MB~数十 MB）禁止 base64 内联进 JSON——
    /// prd-api 先把字节存进共享对象存储拿 RefKey，/gw/raw 只传引用，网关再从同一存储拉取拼 multipart。
    /// 进程内调用仍走 MultipartFiles（字节直传）；本字段仅在 http 模式填充。
    /// 详见 doc/design.llm-gateway-physical-isolation.md §3.1。
    /// </summary>
    public Dictionary<string, MultipartFileRef>? MultipartFileRefs { get; init; }

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
    /// 强制把响应体当二进制读取（按字节）。
    /// 用于下游返回二进制但 Content-Type 标注不可靠的端点
    /// （如 OpenRouter 视频下载 /videos/{id}/content 实际回 mp4 却标 application/json）。
    /// </summary>
    public bool ExpectBinaryResponse { get; init; }

    /// <summary>
    /// 请求上下文（用于日志）
    /// </summary>
    public GatewayRequestContext? Context { get; init; }
}

/// <summary>
/// multipart 文件的对象存储引用（网关物理独立 HTTP 边界用，避免大负载 base64 内联）。
/// 具名 DTO 替代 ValueTuple+byte[]，可干净 JSON 序列化。详见 design.llm-gateway-physical-isolation.md §3.1。
/// </summary>
public sealed class MultipartFileRef
{
    /// <summary>对象存储中的引用键（prd-api 上传后产生，网关据此拉取字节）。</summary>
    public string RefKey { get; init; } = string.Empty;
    public string FileName { get; init; } = string.Empty;
    public string MimeType { get; init; } = string.Empty;
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
    /// 响应内容（原始字符串，文本响应用）
    /// </summary>
    public string? Content { get; init; }

    /// <summary>
    /// 二进制响应内容（TTS 音频等二进制响应用）
    /// </summary>
    public byte[]? BinaryContent { get; init; }

    /// <summary>
    /// 响应的 Content-Type
    /// </summary>
    public string? ContentType { get; init; }

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
