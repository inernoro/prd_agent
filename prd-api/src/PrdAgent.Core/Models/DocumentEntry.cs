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

    /// <summary>父文件夹 ID（null 表示根级）</summary>
    public string? ParentId { get; set; }

    /// <summary>是否为文件夹</summary>
    public bool IsFolder { get; set; }

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

    /// <summary>文档正文的文本索引（用于内容搜索，截取前 2000 字符存入 MongoDB）</summary>
    public string? ContentIndex { get; set; }

    // ── 定期同步字段（功能二：订阅外部源自动更新）──

    /// <summary>外部数据源 URL（RSS/网页/API），为空表示手动上传的文档</summary>
    public string? SourceUrl { get; set; }

    /// <summary>同步间隔（分钟），0 或 null 表示不自动同步</summary>
    public int? SyncIntervalMinutes { get; set; }

    /// <summary>上次同步时间</summary>
    public DateTime? LastSyncAt { get; set; }

    /// <summary>同步状态：idle / syncing / error</summary>
    public string? SyncStatus { get; set; }

    /// <summary>同步错误信息</summary>
    public string? SyncError { get; set; }

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

    /// <summary>订阅源（定期自动拉取）</summary>
    public const string Subscription = "subscription";

    /// <summary>GitHub 目录同步（自动拉取指定目录下所有文件）</summary>
    public const string GithubDirectory = "github_directory";

    public static readonly string[] All = { Upload, Migration, Reference, Import, Subscription, GithubDirectory };
}

/// <summary>同步状态常量</summary>
public static class DocumentSyncStatus
{
    public const string Idle = "idle";
    public const string Syncing = "syncing";
    public const string Error = "error";
}
