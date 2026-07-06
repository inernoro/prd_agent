using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// LLM 网关「影子双发」比对记录（集合 llmshadow_comparisons）。
///
/// 灰度翻 http 前的一致性证据：inproc（权威，返回给调用方）与跨进程 http 网关对同一请求各自解析/响应，
/// 逐字段比对后落一条本记录。默认只比**解析**（DB-only，零额外大模型成本，覆盖 compute-then-send / 选A给B
/// 这类最高风险分歧）；仅在 ShadowFullSamplePercent &gt; 0 时才对采样请求做完整 send 比对（content/finish/token）。
///
/// Id 风格对齐既有 Model（rule #7）：纯 Guid，不加 [BsonId]/[BsonRepresentation]。
/// </summary>
[BsonIgnoreExtraElements]
public class LlmShadowComparison
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>比对种类：resolve（仅解析，免费）/ send（完整非流式）/ stream（流式解析）/ raw（图片/ASR/视频原始代理）/ pools（模型池列表）</summary>
    public string Kind { get; set; } = "resolve";

    /// <summary>对应 LlmRequestContext.RequestId（可关联 llmrequestlogs）</summary>
    public string? RequestId { get; set; }

    /// <summary>产生本条 shadow 证据的 MAP/API 发布 commit。release gate 用它防止旧样本误放行新版本。</summary>
    public string? ReleaseCommit { get; set; }

    /// <summary>请求入口</summary>
    public string AppCallerCode { get; set; } = string.Empty;

    /// <summary>模型类型</summary>
    public string ModelType { get; set; } = string.Empty;

    /// <summary>比对时间</summary>
    public DateTime ComparedAt { get; set; } = DateTime.UtcNow;

    /// <summary>影子（http）侧调用耗时（毫秒）</summary>
    public long ShadowDurationMs { get; set; }

    /// <summary>http 影子是否成功拿到结果（失败=网关不可达/错误，不影响调用方）</summary>
    public bool HttpOk { get; set; }

    /// <summary>http 影子失败时的错误（HttpOk=false 时填）</summary>
    public string? HttpError { get; set; }

    /// <summary>解析字段比对（inproc vs http）</summary>
    public ResolveSnapshot Inproc { get; set; } = new();
    public ResolveSnapshot Http { get; set; } = new();

    /// <summary>逐字段不一致清单（为空=全一致）</summary>
    public List<FieldMismatch> Mismatches { get; set; } = new();

    /// <summary>是否所有比对字段一致（可放心切 http 的总判据）</summary>
    public bool AllMatch { get; set; }

    /// <summary>是否存在 critical 级不一致（model/protocol 漂移——直接阻断翻 http）</summary>
    public bool HasCritical { get; set; }

    // ===== 完整 send 比对（仅 Kind=send/stream 且采样命中时填）=====

    /// <summary>inproc 文本 / http 文本是否逐字一致</summary>
    public bool? TextMatches { get; set; }
    public int? InprocTextChars { get; set; }
    public int? HttpTextChars { get; set; }
    public string? InprocFinishReason { get; set; }
    public string? HttpFinishReason { get; set; }
    public int? InprocOutputTokens { get; set; }
    public int? HttpOutputTokens { get; set; }
}

/// <summary>解析结果快照（取关键可比字段，不含敏感凭据）。</summary>
[BsonIgnoreExtraElements]
public class ResolveSnapshot
{
    public bool Success { get; set; }
    public string? ActualModel { get; set; }
    public string? Protocol { get; set; }
    public string? PlatformType { get; set; }
    public string? ResolutionType { get; set; }
    public string? ModelGroupId { get; set; }
    public bool IsFallback { get; set; }
}

/// <summary>单字段不一致。</summary>
[BsonIgnoreExtraElements]
public class FieldMismatch
{
    public string Field { get; set; } = string.Empty;
    public string? Inproc { get; set; }
    public string? Http { get; set; }
    /// <summary>critical（model/protocol，阻断翻 http）/ warning（其余）</summary>
    public string Severity { get; set; } = "warning";
}
