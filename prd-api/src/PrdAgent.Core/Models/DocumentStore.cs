namespace PrdAgent.Core.Models;

/// <summary>
/// 文档空间（文档存储容器）
/// </summary>
public class DocumentStore
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>空间名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>空间描述</summary>
    public string? Description { get; set; }

    /// <summary>创建者 UserId</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>来源应用标识（可选绑定，如 prd-agent / literary-agent）</summary>
    public string? AppKey { get; set; }

    /// <summary>标签</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>是否公开（其他用户可浏览）</summary>
    public bool IsPublic { get; set; }

    /// <summary>主文档条目 ID（进入空间时默认展示的文档，类似 GitHub README）</summary>
    public string? PrimaryEntryId { get; set; }

    /// <summary>空间内文档数量（冗余计数，便于列表展示）</summary>
    public int DocumentCount { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
