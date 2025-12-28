namespace PrdAgent.Core.Models;

/// <summary>
/// 管理员提示词覆盖（按管理员账号隔离）
/// </summary>
public class AdminPromptOverride
{
    /// <summary>主键（Guid 字符串）</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>所属管理员（JWT sub）</summary>
    public string OwnerAdminId { get; set; } = string.Empty;

    /// <summary>提示词 key（如 imageGenPlan）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>覆盖的 system prompt（原文）</summary>
    public string PromptText { get; set; } = string.Empty;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}


