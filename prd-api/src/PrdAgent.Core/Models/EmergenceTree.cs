namespace PrdAgent.Core.Models;

/// <summary>
/// 涌现树 — 反向自洽涌现探索的根容器。
/// 每棵树从一个"种子文档/方案/对话"出发，通过探索和涌现不断生长。
/// </summary>
public class EmergenceTree
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>树的标题（由种子内容自动提取或用户输入）</summary>
    public string Title { get; set; } = string.Empty;

    public string? Description { get; set; }

    /// <summary>种子节点的原始输入（标题/一段文字/URL）</summary>
    public string SeedContent { get; set; } = string.Empty;

    /// <summary>种子来源类型：document / conversation / text / url</summary>
    public string SeedSourceType { get; set; } = EmergenceSeedSourceType.Text;

    /// <summary>种子关联的源文档 ID（ParsedPrd / DocumentEntry 等），可选</summary>
    public string? SeedSourceId { get; set; }

    public string OwnerId { get; set; } = string.Empty;

    /// <summary>节点总数（反规范化缓存）</summary>
    public int NodeCount { get; set; }

    /// <summary>树的最大深度</summary>
    public int MaxDepth { get; set; }

    public bool IsPublic { get; set; }

    /// <summary>
    /// 是否注入本系统能力作为辅助上下文。
    /// true = 种子内容 + 系统注册表（分析本系统时开启）
    /// false = 纯粹基于种子内容涌现（分析外部系统/通用场景）
    /// </summary>
    public bool InjectSystemCapabilities { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>种子来源类型常量</summary>
public static class EmergenceSeedSourceType
{
    public const string Text = "text";
    public const string Document = "document";
    public const string Conversation = "conversation";
    public const string Url = "url";
}
