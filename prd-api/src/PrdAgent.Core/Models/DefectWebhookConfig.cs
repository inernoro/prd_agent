namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷 Webhook 通知配置
/// </summary>
public class DefectWebhookConfig
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属团队 ID（null = 全局）</summary>
    public string? TeamId { get; set; }

    /// <summary>所属项目 ID（null = 全局）</summary>
    public string? ProjectId { get; set; }

    /// <summary>渠道：wecom / dingtalk / feishu / custom</summary>
    public string Channel { get; set; } = "wecom";

    /// <summary>Webhook URL</summary>
    public string WebhookUrl { get; set; } = string.Empty;

    /// <summary>触发事件：submitted, assigned, escalated, resolved, closed</summary>
    public List<string> TriggerEvents { get; set; } = new();

    /// <summary>是否启用</summary>
    public bool IsEnabled { get; set; } = true;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// Webhook 渠道常量
/// </summary>
public static class WebhookChannel
{
    public const string WeCom = "wecom";
    public const string DingTalk = "dingtalk";
    public const string Feishu = "feishu";
    public const string Custom = "custom";
}

/// <summary>
/// 缺陷事件类型常量
/// </summary>
public static class DefectEventType
{
    public const string Submitted = "submitted";
    public const string Assigned = "assigned";
    public const string Escalated = "escalated";
    public const string Resolved = "resolved";
    public const string Closed = "closed";
    public const string VerifyFailed = "verify-failed";
}
