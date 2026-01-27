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
}

public class SystemPromptEntry
{
    public UserRole Role { get; set; } = UserRole.PM;

    public string SystemPrompt { get; set; } = string.Empty;
}


