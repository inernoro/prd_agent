namespace PrdAgent.Core.Models;

/// <summary>
/// 会话实体
/// </summary>
public class Session
{
    /// <summary>会话唯一标识（通过 IIdGenerator 生成）</summary>
    public string SessionId { get; set; } = string.Empty;
    
    /// <summary>关联的群组ID（可为空表示个人会话）</summary>
    public string? GroupId { get; set; }

    /// <summary>
    /// 会话归属用户ID（个人/临时会话使用；群组会话为空，由 groupId 做隔离）。
    /// </summary>
    public string? OwnerUserId { get; set; }
    
    /// <summary>关联的文档ID（主文档，向后兼容）</summary>
    public string DocumentId { get; set; } = string.Empty;

    /// <summary>关联的文档ID列表（多文档支持；为空时回退到 DocumentId）</summary>
    public List<string> DocumentIds { get; set; } = new();

    /// <summary>各文档的元数据（类型等），按 DocumentId 索引</summary>
    public List<SessionDocumentMeta> DocumentMetas { get; set; } = new();

    /// <summary>获取指定文档的类型（未设置时：主文档默认 product，其他默认 reference）</summary>
    public string GetDocumentType(string documentId)
    {
        var meta = DocumentMetas.FirstOrDefault(m => m.DocumentId == documentId);
        if (meta != null) return meta.DocumentType;
        return string.Equals(DocumentId, documentId, StringComparison.Ordinal) ? "product" : "reference";
    }

    /// <summary>获取所有关联的文档ID（优先 DocumentIds，回退 DocumentId 兼容旧数据）</summary>
    public List<string> GetAllDocumentIds()
    {
        if (DocumentIds.Count > 0)
            return DocumentIds;
        if (!string.IsNullOrEmpty(DocumentId))
            return new List<string> { DocumentId };
        return new List<string>();
    }

    /// <summary>会话标题（可选：用于 IM 形态的会话列表展示）</summary>
    public string? Title { get; set; }
    
    /// <summary>当前角色视角</summary>
    public UserRole CurrentRole { get; set; } = UserRole.PM;
    
    /// <summary>交互模式</summary>
    public InteractionMode Mode { get; set; } = InteractionMode.QA;
    
    /// <summary>引导模式当前步骤</summary>
    public int? GuideStep { get; set; }
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    /// <summary>最后活跃时间</summary>
    public DateTime LastActiveAt { get; set; } = DateTime.UtcNow;

    /// <summary>归档时间（UTC；非空表示会话已归档）</summary>
    public DateTime? ArchivedAtUtc { get; set; }

    /// <summary>删除时间（UTC；非空表示会话已软删除）</summary>
    public DateTime? DeletedAtUtc { get; set; }
}

/// <summary>
/// 会话内文档元数据（类型标记等）
/// </summary>
public class SessionDocumentMeta
{
    /// <summary>文档ID</summary>
    public string DocumentId { get; set; } = string.Empty;

    /// <summary>文档类型：product(产品文档)、technical(技术文档)、design(设计文档)、reference(参考资料)</summary>
    public string DocumentType { get; set; } = "reference";
}
