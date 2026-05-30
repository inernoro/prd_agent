namespace PrdAgent.Core.Models;

/// <summary>
/// 任务活动记录 — 评论 + 变更日志（进度留痕 / 协作）。
/// </summary>
public class PmTaskActivity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string TaskId { get; set; } = string.Empty;
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>类型：comment(评论) / change(字段变更)</summary>
    public string Type { get; set; } = PmActivityType.Comment;

    public string UserId { get; set; } = string.Empty;
    public string? UserName { get; set; }

    /// <summary>评论正文（Type=comment）</summary>
    public string? Content { get; set; }

    /// <summary>变更字段（Type=change），如 status / priority / assignee / title</summary>
    public string? Field { get; set; }
    public string? FromValue { get; set; }
    public string? ToValue { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>任务活动类型常量</summary>
public static class PmActivityType
{
    public const string Comment = "comment";
    public const string Change = "change";
}
