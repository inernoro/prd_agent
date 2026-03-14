namespace PrdAgent.Core.Models;

/// <summary>
/// 用户收藏内容（通过快捷指令、网页、桌面端等方式收藏的链接/文本）
/// </summary>
public class UserCollection
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属用户ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>来自哪个快捷指令（可选）</summary>
    public string? ShortcutId { get; set; }

    /// <summary>收藏的链接</summary>
    public string? Url { get; set; }

    /// <summary>附加文字或纯文本收藏</summary>
    public string? Text { get; set; }

    /// <summary>用户标签</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>
    /// 来源渠道：shortcuts / web / desktop / api
    /// </summary>
    public string Source { get; set; } = "shortcuts";

    /// <summary>
    /// 状态：saved / processing / completed / failed
    /// </summary>
    public string Status { get; set; } = CollectionStatus.Saved;

    /// <summary>工作流/LLM 返回的结果（预留）</summary>
    public string? Result { get; set; }

    /// <summary>额外元数据</summary>
    public Dictionary<string, object> Metadata { get; set; } = new();

    /// <summary>关联的 ChannelTask ID（如有）</summary>
    public string? ChannelTaskId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 收藏状态常量
/// </summary>
public static class CollectionStatus
{
    public const string Saved = "saved";
    public const string Processing = "processing";
    public const string Completed = "completed";
    public const string Failed = "failed";
}
