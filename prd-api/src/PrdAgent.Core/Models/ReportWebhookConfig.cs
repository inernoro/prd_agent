namespace PrdAgent.Core.Models;

/// <summary>
/// 周报 Webhook 通知配置
/// </summary>
public class ReportWebhookConfig
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属团队 ID</summary>
    public string TeamId { get; set; } = string.Empty;

    /// <summary>渠道：wecom / dingtalk / feishu / custom</summary>
    public string Channel { get; set; } = WebhookChannel.WeCom;

    /// <summary>Webhook URL</summary>
    public string WebhookUrl { get; set; } = string.Empty;

    /// <summary>触发事件列表</summary>
    public List<string> TriggerEvents { get; set; } = new();

    /// <summary>是否启用</summary>
    public bool IsEnabled { get; set; } = true;

    /// <summary>备注名称（如"前端群"、"管理群"）</summary>
    public string? Name { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 周报事件类型常量
/// </summary>
public static class ReportEventType
{
    public const string Submitted = "submitted";
    public const string AllSubmitted = "all_submitted";
    public const string Reviewed = "reviewed";
    public const string Returned = "returned";
    public const string DeadlineApproaching = "deadline_approaching";
    public const string Overdue = "overdue";

    public static readonly string[] All =
    {
        Submitted, AllSubmitted, Reviewed, Returned, DeadlineApproaching, Overdue
    };
}
