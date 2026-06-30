using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.LlmGw.Models;

/// <summary>
/// 共享集合 llmrequestlogs 的 POCO 投影（仅取本网关观测需要的字段子集）。
///
/// 重要：该集合由 prd-api 的 .NET 驱动以 PascalCase 字段名序列化（无 camelCase 约定），
/// 因此这里的属性名必须与之保持一致。数值字段（DurationMs / Tokens / StatusCode）在历史
/// 文档里可能是 Int32 / Int64 / Double 混存，直接反序列化到强类型 POCO 容易抛
/// FormatException。为彻底规避此类型不匹配问题，列表/详情/聚合查询统一以
/// IMongoCollection&lt;BsonDocument&gt; 读取，再用 BsonValueHelpers 手动安全映射；本 POCO
/// 仅作为字段契约文档保留，并未在查询路径上直接使用。
/// </summary>
[BsonIgnoreExtraElements]
public class LlmRequestLogDoc
{
    [BsonId]
    public string Id { get; set; } = string.Empty;

    public string RequestId { get; set; } = string.Empty;
    public string? GroupId { get; set; }
    public string? SessionId { get; set; }
    public string? UserId { get; set; }

    public string? RequestType { get; set; }
    public string? AppCallerCode { get; set; }
    public string? AppCallerCodeDisplayName { get; set; }

    public string Provider { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string? PlatformId { get; set; }
    public string? PlatformName { get; set; }
    public string? Protocol { get; set; }
    public string? ResolutionReason { get; set; }

    public string RequestBodyRedacted { get; set; } = string.Empty;
    public string? SystemPromptText { get; set; }
    public string? QuestionText { get; set; }
    public string? AnswerText { get; set; }
    public string? ThinkingText { get; set; }
    public string? ResponseToolCalls { get; set; }
    public int? ToolCallCount { get; set; }
    public string? FinishReason { get; set; }
    public bool? IsStreaming { get; set; }

    public int? InputTokens { get; set; }
    public int? OutputTokens { get; set; }
    public int? StatusCode { get; set; }
    public string Status { get; set; } = string.Empty;

    public DateTime StartedAt { get; set; }
    public DateTime? FirstByteAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public long? DurationMs { get; set; }

    public bool? IsFallback { get; set; }
    public string? FallbackReason { get; set; }
    public string? ExpectedModel { get; set; }
    public string? Error { get; set; }
}
