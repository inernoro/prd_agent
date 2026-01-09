namespace PrdAgent.Core.Models;

/// <summary>
/// 文学创作提示词（全局共享，按场景分类）
/// - 与 PromptEntry 不同：不绑定 UserRole（PM/DEV/QA），而是按 ScenarioType 分类
/// - 存储在独立集合 LiteraryPrompts 中，避免与现有 Prompts 冲突
/// </summary>
public class LiteraryPrompt
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>创建者（ADMIN userId）</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>提示词标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>提示词内容</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>
    /// 场景类型：
    /// - null/"global": 全局共享（所有场景可用）
    /// - "article-illustration": 文章配图专用
    /// - "image-gen": 图片生成专用
    /// - "other": 其他场景
    /// </summary>
    public string? ScenarioType { get; set; }

    /// <summary>排序号（同一场景下从小到大排列）</summary>
    public int Order { get; set; }

    /// <summary>是否为系统预置（系统预置不可删除，但可编辑）</summary>
    public bool IsSystem { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
