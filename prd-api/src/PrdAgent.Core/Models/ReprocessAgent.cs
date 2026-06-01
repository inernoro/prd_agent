namespace PrdAgent.Core.Models;

/// <summary>
/// 文档再加工·可调用智能体。
///
/// 设计：
/// - 内置智能体（Visibility=system）由 ReprocessAgentSeeder 启动时种入，OwnerUserId 为空，禁止用户删除
/// - 个人智能体（Visibility=personal）由用户在 Chat 抽屉里创建，OwnerUserId 必填
/// - Key 全局唯一（system 与 personal 共享命名空间，建议 personal 加用户前缀避免冲突）
/// - 调用时 ContentReprocessProcessor 用 Key 反查 SystemPrompt 拼到对话 system 段
/// </summary>
public class ReprocessAgent
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>kebab-case 唯一标识，前端 chip 用作 templateKey</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>展示名（chip 文本）</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>简短描述（tooltip）</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>该智能体的 system prompt（用户输入或种子写入）</summary>
    public string SystemPrompt { get; set; } = string.Empty;

    /// <summary>system 或 personal</summary>
    public string Visibility { get; set; } = ReprocessAgentVisibility.Personal;

    /// <summary>个人智能体的创建者；system 为 null</summary>
    public string? OwnerUserId { get; set; }

    /// <summary>排序，越小越靠前</summary>
    public int SortOrder { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedAt { get; set; }
}

public static class ReprocessAgentVisibility
{
    public const string System = "system";
    public const string Personal = "personal";
}
