namespace PrdAgent.Core.Models;

/// <summary>
/// 知识库文档内的"划词评论"（作用在正文的某段原文上，而非整章节）。
///
/// 与 PrdComment 的区别：
/// - PrdComment 按 heading slug 聚合，是章节评论
/// - DocumentInlineComment 按"被选中的字符范围 + 前后上下文"锚定，是段落评论
/// - 文档正文更新后通过 SelectedText + Context 重锚定
/// </summary>
public class DocumentInlineComment
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属知识库</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>所属文档条目</summary>
    public string EntryId { get; set; } = string.Empty;

    /// <summary>关联的正文文档 ID（ParsedPrd.Id）</summary>
    public string DocumentId { get; set; } = string.Empty;

    /// <summary>创建时的正文 SHA256（用于检测文档是否被更新）</summary>
    public string? ContentHash { get; set; }

    /// <summary>被选中的原文片段（rebind 的关键字段）</summary>
    public string SelectedText { get; set; } = string.Empty;

    /// <summary>选中片段前的上下文（约 50 字符，用于多处命中消歧）</summary>
    public string ContextBefore { get; set; } = string.Empty;

    /// <summary>选中片段后的上下文（约 50 字符）</summary>
    public string ContextAfter { get; set; } = string.Empty;

    /// <summary>起始字符偏移量（hint；rebind 后会更新）</summary>
    public int StartOffset { get; set; }

    /// <summary>结束字符偏移量（hint；rebind 后会更新）</summary>
    public int EndOffset { get; set; }

    /// <summary>评论内容</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>作者用户 ID</summary>
    public string AuthorUserId { get; set; } = string.Empty;

    /// <summary>作者显示名快照</summary>
    public string AuthorDisplayName { get; set; } = string.Empty;

    /// <summary>作者头像快照</summary>
    public string? AuthorAvatar { get; set; }

    /// <summary>
    /// 锚定状态：
    /// - active: SelectedText 在当前正文里能找到（唯一或上下文消歧命中）
    /// - orphaned: 正文更新后找不到原片段，评论保留但不再高亮正文
    /// </summary>
    public string Status { get; set; } = DocumentInlineCommentStatus.Active;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedAt { get; set; }
}

public static class DocumentInlineCommentStatus
{
    public const string Active = "active";
    public const string Orphaned = "orphaned";
}
