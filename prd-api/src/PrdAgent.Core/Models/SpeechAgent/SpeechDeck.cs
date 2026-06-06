namespace PrdAgent.Core.Models.SpeechAgent;

/// <summary>
/// 演讲智能体 — 一份"演讲"，对应一棵思维导图。
/// 首期支持 mode = "mindmap"（思维导图演讲），后续可扩 outline / story / data 等模式。
/// </summary>
public class SpeechDeck
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string OwnerUserId { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    /// <summary>演讲模式：mindmap（思维导图演讲）/ outline / story / data，预留扩展。</summary>
    public string Mode { get; set; } = SpeechDeckMode.Mindmap;

    /// <summary>来源类型：document（知识库文档）/ upload（上传文件）/ paste（粘贴文本）。</summary>
    public string SourceType { get; set; } = SpeechDeckSourceType.Paste;

    /// <summary>来源引用 Id（DocumentEntry/Attachment Id，paste 时为 null）。</summary>
    public string? SourceRefId { get; set; }

    /// <summary>原始文本（最长截断到 SourceTextMaxChars，便于回放/重生）。</summary>
    public string SourceText { get; set; } = string.Empty;

    /// <summary>受众标签：'通识' / '产品经理' / '工程师' / '客户' / 自定义。</summary>
    public string Audience { get; set; } = "通识";

    /// <summary>风格标签：'专业' / '故事化' / '简洁' / '幽默'。</summary>
    public string Style { get; set; } = "专业";

    /// <summary>目标深度：2-4，决定大纲层级。</summary>
    public int Depth { get; set; } = 3;

    /// <summary>主题配色（前端 token key），白天暗黑均自适应。</summary>
    public string Theme { get; set; } = "default";

    /// <summary>生成状态：draft / generating / ready / failed。</summary>
    public string Status { get; set; } = SpeechDeckStatus.Draft;

    /// <summary>失败原因（失败时填）。</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>封面图 ImageAsset Id（复用 image_assets，Phase 2）。</summary>
    public string? CoverImageAssetId { get; set; }

    /// <summary>本次生成所用模型（流式 Start chunk 写入，前端展示）。</summary>
    public string? Model { get; set; }

    public string? Platform { get; set; }

    /// <summary>节点数（冗余，列表卡片展示）。</summary>
    public int NodeCount { get; set; }

    /// <summary>已发布的 HostedSite Id（Phase 2 接入）。</summary>
    public string? PublishedSiteId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public static class SpeechDeckMode
{
    public const string Mindmap = "mindmap";
}

public static class SpeechDeckSourceType
{
    public const string Document = "document";
    public const string Upload = "upload";
    public const string Paste = "paste";
}

public static class SpeechDeckStatus
{
    public const string Draft = "draft";
    public const string Generating = "generating";
    public const string Ready = "ready";
    public const string Failed = "failed";
}
