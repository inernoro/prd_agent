using PrdAgent.Core.Attributes;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Core.Models;

/// <summary>
/// 大模型请求日志（用于调试与监控；注意：不得存储 PRD 原文与敏感信息）
/// </summary>
[AppOwnership(AppNames.Llm, AppNames.LlmDisplay, IsPrimary = true)]
public class LlmRequestLog
{
    public string Id { get; set; } = Guid.NewGuid().ToString();

    // 关联/定位
    public string RequestId { get; set; } = string.Empty;
    public string? GroupId { get; set; }
    public string? SessionId { get; set; }
    public string? UserId { get; set; }
    public string? ViewRole { get; set; }

    // 本次调用类型/用途（用于追溯"这次请求是做什么的"）
    // - RequestType: 推理/意图/识图/生图/unknown/...
    // - RequestPurpose: 业务侧用途标识（AppCallerCode，如 prd-agent-desktop.chat.sendmessage::chat）
    // - RequestPurposeDisplayName: 中文显示名（日志写入时从 AppCallerRegistry 获取，自包含）
    public string? RequestType { get; set; }
    public string? RequestPurpose { get; set; }
    /// <summary>
    /// RequestPurpose 的中文显示名（日志写入时一次性保存，确保日志自包含）
    /// </summary>
    public string? RequestPurposeDisplayName { get; set; }

    // Provider / 模型信息
    public string Provider { get; set; } = string.Empty; // Claude/OpenAI/...
    public string Model { get; set; } = string.Empty;
    public string? ApiBase { get; set; }
    public string? Path { get; set; }
    /// <summary>
    /// 外部请求 HTTP Method（GET/POST/...），用于管理后台回放/复制 curl。
    /// </summary>
    public string? HttpMethod { get; set; }

    // 平台信息（来自 LLMPlatform）
    public string? PlatformId { get; set; }
    public string? PlatformName { get; set; }

    // 模型池信息（来自 ModelGroup）
    /// <summary>
    /// 模型解析类型（0=直连单模型, 1=默认模型池, 2=专属模型池）
    /// </summary>
    public ModelResolutionType? ModelResolutionType { get; set; }
    /// <summary>使用的模型池ID</summary>
    public string? ModelGroupId { get; set; }
    /// <summary>使用的模型池名称</summary>
    public string? ModelGroupName { get; set; }

    // 请求（密钥已隐藏；正文按后端策略可能为摘要/占位符）
    public Dictionary<string, string>? RequestHeadersRedacted { get; set; }
    public string RequestBodyRedacted { get; set; } = string.Empty;
    public string? RequestBodyHash { get; set; }
    /// <summary>
    /// requestBodyRedacted 原始字符数（落库前，未截断）
    /// </summary>
    public int? RequestBodyChars { get; set; }
    /// <summary>
    /// 是否对 requestBodyRedacted 做过截断（落库时为了控制体积）
    /// </summary>
    public bool? RequestBodyTruncated { get; set; }
    public int? SystemPromptChars { get; set; }
    public string? SystemPromptHash { get; set; }
    /// <summary>
    /// 实际发送给模型的 system prompt（用于管理员调试；可能为空；超长会被截断）
    /// </summary>
    public string? SystemPromptText { get; set; }
    public int? MessageCount { get; set; }

    // 文档元信息（不落盘 PRD 原文）
    public int? DocumentChars { get; set; }
    public string? DocumentHash { get; set; }

    /// <summary>
    /// 用户提示词字符数（本次请求 messages 中所有 user 内容长度总和；不含 system prompt）
    /// </summary>
    public int? UserPromptChars { get; set; }

    /// <summary>
    /// Token 统计来源：
    /// - reported：上游 Provider 返回 usage
    /// - estimated：本系统估算（如上游未返回 usage）
    /// - missing：未上报/未知
    /// </summary>
    public string? TokenUsageSource { get; set; }

    /// <summary>
    /// 生图成功张数（文本模型不使用该字段）
    /// </summary>
    public int? ImageSuccessCount { get; set; }

    // 交互内容（仅脱敏 token/密钥；PRD 正文不落盘由上游保证）
    // - QuestionText/AnswerText 用于管理后台快速查看
    // - 单条上限 200k 字符（超出会被截断；并记录 hash/长度用于对照）
    public string? QuestionText { get; set; }
    public string? AnswerText { get; set; }
    /// <summary>
    /// AI 思考过程文本（DeepSeek reasoning_content / &lt;think&gt; 标签内容），与 AnswerText 分开存储。
    /// </summary>
    public string? ThinkingText { get; set; }
    public int? AnswerTextChars { get; set; }
    public string? AnswerTextHash { get; set; }

    // 响应（不再记录 rawSSE）
    public int? StatusCode { get; set; }
    public Dictionary<string, string>? ResponseHeaders { get; set; }
    public int? AssembledTextChars { get; set; } // 保留：用于摘要统计（与 AnswerTextChars 一致）
    public string? AssembledTextHash { get; set; } // 保留：用于摘要统计（与 AnswerTextHash 一致）
    public string? Error { get; set; }

    // usage/cache
    public int? InputTokens { get; set; }
    public int? OutputTokens { get; set; }
    public int? CacheCreationInputTokens { get; set; }
    public int? CacheReadInputTokens { get; set; }

    // Exchange 中继信息
    /// <summary>是否为 Exchange 中继请求</summary>
    public bool? IsExchange { get; set; }
    /// <summary>Exchange 配置 ID</summary>
    public string? ExchangeId { get; set; }
    /// <summary>Exchange 显示名称（自包含）</summary>
    public string? ExchangeName { get; set; }
    /// <summary>Exchange 转换器类型</summary>
    public string? ExchangeTransformerType { get; set; }

    // 模型降级/回退信息
    /// <summary>是否发生了模型降级（期望模型与实际模型不一致，或模型池回退）</summary>
    public bool? IsFallback { get; set; }
    /// <summary>降级原因（如：模型池中所有模型不可用，回退到直连模型）</summary>
    public string? FallbackReason { get; set; }
    /// <summary>期望使用的模型名称</summary>
    public string? ExpectedModel { get; set; }

    // 图片引用（用于管理后台日志页展示参考图 COS URL，不存 base64）
    /// <summary>
    /// 本次请求涉及的图片引用列表（参考图、蒙版等），仅存元数据和 COS URL
    /// </summary>
    public List<LlmImageReference>? ImageReferences { get; set; }

    // ===== 新版图片日志（简化架构：前端传 URL → 直写日志，无需 UploadArtifact 中转） =====
    /// <summary>输入参考图列表（COS URL 来自前端上传）</summary>
    public List<LlmLogImage>? InputImages { get; set; }
    /// <summary>生成结果图列表（COS URL 来自生图结果）</summary>
    public List<LlmLogImage>? OutputImages { get; set; }

    // 时序
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? FirstByteAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public long? DurationMs { get; set; }

    // 状态
    public string Status { get; set; } = "running"; // running/succeeded/failed/cancelled
}

/// <summary>
/// LLM 请求日志中的图片引用（不存 base64，仅存 COS URL 和元数据）
/// </summary>
public class LlmImageReference
{
    public string? Sha256 { get; set; }
    public string? CosUrl { get; set; }
    public string? Label { get; set; }
    public string? MimeType { get; set; }
    public long? SizeBytes { get; set; }
}

/// <summary>
/// 日志中的图片记录（输入参考图 / 输出生成图），仅存 COS URL
/// </summary>
public class LlmLogImage
{
    /// <summary>COS 地址（展示用，有水印时为水印版）</summary>
    public string Url { get; set; } = string.Empty;
    /// <summary>原图 COS 地址（无水印）</summary>
    public string? OriginalUrl { get; set; }
    /// <summary>标签（如"手绘草图"、"参考图"、"生成结果"）</summary>
    public string? Label { get; set; }
    public string? Sha256 { get; set; }
}

