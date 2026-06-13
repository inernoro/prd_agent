namespace PrdAgent.Core.Models;

/// <summary>
/// 短视频素材解析运行记录。
/// </summary>
public class ShortVideoMaterialRun
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>发起用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>原始短视频链接</summary>
    public string VideoUrl { get; set; } = string.Empty;

    /// <summary>识别到的平台</summary>
    public string Platform { get; set; } = "unknown";

    /// <summary>素材标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>用户提交时传入的标题，用于后台任务恢复</summary>
    public string? RequestedTitle { get; set; }

    /// <summary>用户提交时附带的字幕/文案，用于后台任务恢复</summary>
    public string? InputSourceText { get; set; }

    /// <summary>文案/字幕来源：manual / tikhub-metadata / metadata-fallback</summary>
    public string SourceMode { get; set; } = "manual";

    /// <summary>短视频解析器返回的元数据 JSON</summary>
    public string? ParsedMetadataJson { get; set; }

    /// <summary>解析过程说明</summary>
    public string? ParserMessage { get; set; }

    /// <summary>状态：running / done / failed</summary>
    public string Status { get; set; } = "running";

    /// <summary>阶段记录</summary>
    public List<ShortVideoMaterialStage> Stages { get; set; } = new();

    /// <summary>知识库 ID</summary>
    public string? StoreId { get; set; }

    /// <summary>默认选中的产物条目 ID</summary>
    public string? EntryId { get; set; }

    /// <summary>原始视频素材条目 ID</summary>
    public string? SourceEntryId { get; set; }

    /// <summary>字幕文稿条目 ID</summary>
    public string? TranscriptEntryId { get; set; }

    /// <summary>时间轴片段条目 ID</summary>
    public string? TimelineEntryId { get; set; }

    /// <summary>错误信息</summary>
    public string? ErrorMessage { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class ShortVideoMaterialStage
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
