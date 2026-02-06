using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 提示词设置（单例文档：Id 固定为 global）
/// - 每条配置项对应一个角色下的"提示词条目"：title + promptTemplate + order + promptKey
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
public class PromptSettings
{
    /// <summary>固定为 global</summary>
    public string Id { get; set; } = "global";

    public List<PromptEntry> Prompts { get; set; } = new();

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 单条提示词配置（对某一个角色有效）
/// </summary>
public class PromptEntry
{
    /// <summary>稳定标识（全局唯一）</summary>
    public string PromptKey { get; set; } = string.Empty;

    /// <summary>仅允许 PM/DEV/QA</summary>
    public UserRole Role { get; set; } = UserRole.PM;

    /// <summary>该角色下的排序号（从 1 开始）</summary>
    public int Order { get; set; }

    /// <summary>小标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>提示词模板</summary>
    public string PromptTemplate { get; set; } = string.Empty;

    /// <summary>
    /// 场景类型（可选）：
    /// - null/"global": 全局共享（所有场景可用）
    /// - "article-illustration": 文章配图专用
    /// - "image-gen": 图片生成专用
    /// - "other": 其他场景
    /// </summary>
    public string? ScenarioType { get; set; }
}

/// <summary>
/// 提示词 DTO（用于 ChatService 注入）
/// </summary>
public class RolePrompt
{
    public string Title { get; set; } = string.Empty;
    public string PromptTemplate { get; set; } = string.Empty;
}


