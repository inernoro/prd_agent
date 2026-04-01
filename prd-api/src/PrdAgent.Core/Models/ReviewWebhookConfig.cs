namespace PrdAgent.Core.Models;

/// <summary>
/// 产品评审员 Webhook 通知配置（全局维度，管理员配置）
/// </summary>
public class ReviewWebhookConfig
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>渠道：wecom / dingtalk / feishu / custom</summary>
    public string Channel { get; set; } = WebhookChannel.WeCom;

    /// <summary>Webhook URL</summary>
    public string WebhookUrl { get; set; } = string.Empty;

    /// <summary>触发事件列表</summary>
    public List<string> TriggerEvents { get; set; } = new();

    /// <summary>是否启用</summary>
    public bool IsEnabled { get; set; } = true;

    /// <summary>备注名称</summary>
    public string? Name { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 评审事件类型常量
/// </summary>
public static class ReviewEventType
{
    public const string ReviewCompleted = "review_completed";

    public static readonly string[] All = { ReviewCompleted };
}
