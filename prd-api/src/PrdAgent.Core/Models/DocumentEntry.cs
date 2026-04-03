namespace PrdAgent.Core.Models;

/// <summary>
/// 文档条目（文档空间中的一条记录）
/// </summary>
public class DocumentEntry
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属文档空间 ID</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>关联的解析文档 ID（文本类文档，指向 ParsedPrd）</summary>
    public string? DocumentId { get; set; }

    /// <summary>关联的附件 ID（文件类文档，指向 Attachment）</summary>
    public string? AttachmentId { get; set; }

    /// <summary>文档标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>文档摘要（可由 AI 生成或用户填写）</summary>
    public string? Summary { get; set; }

    /// <summary>来源类型：upload / migration / reference / import</summary>
    public string SourceType { get; set; } = DocumentSourceType.Upload;

    /// <summary>内容 MIME 类型（如 text/markdown, application/pdf）</summary>
    public string ContentType { get; set; } = string.Empty;

    /// <summary>文件大小（字节）</summary>
    public long FileSize { get; set; }

    /// <summary>标签</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>扩展元数据（键值对，便于不同来源携带额外信息）</summary>
    public Dictionary<string, string> Metadata { get; set; } = new();

    /// <summary>上传/创建者 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 文档来源类型常量
/// </summary>
public static class DocumentSourceType
{
    /// <summary>用户上传</summary>
    public const string Upload = "upload";

    /// <summary>数据迁移导入</summary>
    public const string Migration = "migration";

    /// <summary>参考资料引用</summary>
    public const string Reference = "reference";

    /// <summary>外部导入（API / 第三方）</summary>
    public const string Import = "import";

    public static readonly string[] All = { Upload, Migration, Reference, Import };
}
