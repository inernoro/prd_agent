namespace PrdAgent.Core.Models;

/// <summary>
/// 个人任务树 — 以"创世支柱 → 主干 → 枝干"的方式组织个人任务。
/// 每个用户可拥有多棵树；树根节点即"创世支柱"，向下生长出主干与枝干。
/// 目标：方便地（含对话摘取）把个人任务及其卡点暴露出来，让自己和上级一眼看清推进进度。
/// </summary>
public class TaskTree
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>树标题（创世支柱标题，由用户输入或对话提取）</summary>
    public string Title { get; set; } = string.Empty;

    public string? Description { get; set; }

    /// <summary>所属用户</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>节点总数（反规范化缓存）</summary>
    public int NodeCount { get; set; }

    /// <summary>树的最大深度（反规范化缓存）</summary>
    public int MaxDepth { get; set; }

    /// <summary>是否归档（归档后不在默认列表展示）</summary>
    public bool IsArchived { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
