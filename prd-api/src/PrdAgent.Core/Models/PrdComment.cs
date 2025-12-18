namespace PrdAgent.Core.Models;

/// <summary>
/// PRD 章节评论（与群组无关，但写入/读取权限由 groupId 预览校验决定）
/// </summary>
public class PrdComment
{
    /// <summary>评论 ID（MongoDB ObjectId 字符串）</summary>
    public string? Id { get; set; }

    /// <summary>PRD 文档 ID（ParsedPrd.Id）</summary>
    public string DocumentId { get; set; } = string.Empty;

    /// <summary>章节锚点（由标题文本 slugger 生成）</summary>
    public string HeadingId { get; set; } = string.Empty;

    /// <summary>标题快照（用于标题变更后的展示）</summary>
    public string HeadingTitleSnapshot { get; set; } = string.Empty;

    /// <summary>作者用户 ID</summary>
    public string AuthorUserId { get; set; } = string.Empty;

    /// <summary>作者展示名（快照）</summary>
    public string AuthorDisplayName { get; set; } = string.Empty;

    /// <summary>评论内容</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>更新时间</summary>
    public DateTime? UpdatedAt { get; set; }
}
