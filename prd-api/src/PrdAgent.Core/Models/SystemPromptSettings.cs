using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 系统提示词设置（单例文档：Id 固定为 global）
/// - 仅用于 PRD 问答的 system prompt（非 JSON 输出任务）
/// - 按角色（PM/DEV/QA）分别配置
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
public class SystemPromptSettings
{
    /// <summary>固定为 global</summary>
    public string Id { get; set; } = "global";

    public List<SystemPromptEntry> Entries { get; set; } = new();

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 种子版本：当 SystemPromptService 首次根据 PromptManager 默认值自动 seed 时写入此字段。
    /// 用于识别"自动种子 vs 管理员主动覆盖"：
    /// - SeededVersion != null 且 SeededVersion != 当前代码版本 → 旧种子，自动刷新为新默认值
    /// - SeededVersion == null（或被管理员 PUT 覆盖时清空）→ 管理员主动编辑，永远保留
    /// 没有该字段意味着系统在 2026-04-18 之前就已 seed，按"可能被编辑过"保守处理（不自动覆盖）。
    /// </summary>
    public string? SeededVersion { get; set; }
}

public class SystemPromptEntry
{
    public UserRole Role { get; set; } = UserRole.PM;

    public string SystemPrompt { get; set; } = string.Empty;
}


