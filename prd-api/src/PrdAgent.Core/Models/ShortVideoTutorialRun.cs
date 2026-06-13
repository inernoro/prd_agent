namespace PrdAgent.Core.Models;

/// <summary>
/// 短视频教程流水线运行记录。
/// </summary>
public class ShortVideoTutorialRun
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>发起用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>原始短视频链接</summary>
    public string VideoUrl { get; set; } = string.Empty;

    /// <summary>识别到的平台</summary>
    public string Platform { get; set; } = "unknown";

    /// <summary>教程标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>文案/字幕来源：manual / tikhub-metadata / metadata-fallback</summary>
    public string SourceMode { get; set; } = "manual";

    /// <summary>短视频解析器返回的元数据 JSON</summary>
    public string? ParsedMetadataJson { get; set; }

    /// <summary>解析过程说明</summary>
    public string? ParserMessage { get; set; }

    /// <summary>状态：running / done / failed</summary>
    public string Status { get; set; } = "running";

    /// <summary>阶段记录</summary>
    public List<ShortVideoTutorialStage> Stages { get; set; } = new();

    /// <summary>知识库 ID</summary>
    public string? StoreId { get; set; }

    /// <summary>教程文档条目 ID</summary>
    public string? EntryId { get; set; }

    /// <summary>网页托管站点 ID</summary>
    public string? SiteId { get; set; }

    /// <summary>网页托管分享 ID</summary>
    public string? ShareId { get; set; }

    /// <summary>网页托管分享 token</summary>
    public string? ShareToken { get; set; }

    /// <summary>错误信息</summary>
    public string? ErrorMessage { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class ShortVideoTutorialStage
{
    /// <summary>阶段键</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>阶段标题</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>阶段状态：pending / running / done / failed</summary>
    public string Status { get; set; } = "pending";

    /// <summary>阶段说明</summary>
    public string Message { get; set; } = string.Empty;

    public DateTime At { get; set; } = DateTime.UtcNow;
}
