namespace PrdAgent.Core.Models;

/// <summary>
/// 知识库文档实体
/// </summary>
public class KbDocument
{
    /// <summary>文档唯一标识（UUID）</summary>
    public string DocumentId { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属群组ID</summary>
    public string GroupId { get; set; } = string.Empty;

    /// <summary>原始文件名</summary>
    public string FileName { get; set; } = string.Empty;

    /// <summary>文件类型</summary>
    public KbFileType FileType { get; set; } = KbFileType.Pdf;

    /// <summary>文件大小（字节）</summary>
    public long FileSize { get; set; }

    /// <summary>COS 存储 URL</summary>
    public string FileUrl { get; set; } = string.Empty;

    /// <summary>COS 对象的 SHA256（用于删除）</summary>
    public string FileSha256 { get; set; } = string.Empty;

    /// <summary>提取的文本内容（用于 LLM 注入）</summary>
    public string? TextContent { get; set; }

    /// <summary>字符数</summary>
    public int CharCount { get; set; }

    /// <summary>Token 估算</summary>
    public int TokenEstimate { get; set; }

    /// <summary>上传者 UserId</summary>
    public string UploadedBy { get; set; } = string.Empty;

    /// <summary>上传时间</summary>
    public DateTime UploadedAt { get; set; } = DateTime.UtcNow;

    /// <summary>替换版本号（从 1 开始，每次替换 +1）</summary>
    public int ReplaceVersion { get; set; } = 1;

    /// <summary>文档状态</summary>
    public KbDocumentStatus Status { get; set; } = KbDocumentStatus.Active;
}

/// <summary>
/// 知识库文件类型
/// </summary>
public enum KbFileType
{
    Pdf,
    Markdown
}

/// <summary>
/// 知识库文档状态
/// </summary>
public enum KbDocumentStatus
{
    Active,
    Deleted
}
