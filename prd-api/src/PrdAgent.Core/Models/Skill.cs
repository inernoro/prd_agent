namespace PrdAgent.Core.Models;

/// <summary>
/// 技能定义：用户可自建的提示词升级体，挂载在对话输入区的技能按钮上。
/// 内置技能由系统预置，用户技能由个人创建，两者共用同一数据结构。
/// </summary>
public class Skill
{
    public string Id { get; set; } = string.Empty;

    /// <summary>显示名称</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>一句话描述（给用户看）</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>图标名称 (lucide-react icon name, 如 "FileSearch")</summary>
    public string? Icon { get; set; }

    /// <summary>分类标签 (如 "requirement-analysis", "technical-design", "test-planning", "doc-generation", "general")</summary>
    public string Category { get; set; } = "general";

    /// <summary>排序权重（越小越靠前）</summary>
    public int Order { get; set; }

    // ── 执行定义 ──

    /// <summary>系统提示词模板（注入到 system prompt 中）</summary>
    public string SystemPromptTemplate { get; set; } = string.Empty;

    /// <summary>用户消息模板（追加到用户输入后面，作为聚焦指令）</summary>
    public string UserPromptTemplate { get; set; } = string.Empty;

    // ── 访问控制 ──

    /// <summary>允许使用的角色（空列表 = 所有角色可用）</summary>
    public List<string> AllowedRoles { get; set; } = new();

    // ── 归属 ──

    /// <summary>是否为系统内置技能（内置技能不可删除，所有用户可见）</summary>
    public bool IsBuiltIn { get; set; }

    /// <summary>创建者用户 ID（内置技能此字段为空）</summary>
    public string? OwnerUserId { get; set; }

    // ── 元数据 ──

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
