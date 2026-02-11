namespace PrdAgent.Core.Models;

/// <summary>
/// Webhook 投递日志
/// </summary>
public class WebhookDeliveryLog
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的开放平台应用 ID</summary>
    public string AppId { get; set; } = string.Empty;

    /// <summary>通知类型（如 quota_exceed）</summary>
    public string Type { get; set; } = string.Empty;

    /// <summary>通知标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>投递的 Webhook URL</summary>
    public string WebhookUrl { get; set; } = string.Empty;

    /// <summary>请求载荷（JSON 字符串）</summary>
    public string? RequestBody { get; set; }

    /// <summary>HTTP 响应状态码</summary>
    public int? StatusCode { get; set; }

    /// <summary>响应体（截断保留前 2KB）</summary>
    public string? ResponseBody { get; set; }

    /// <summary>投递耗时（毫秒）</summary>
    public long? DurationMs { get; set; }

    /// <summary>是否投递成功</summary>
    public bool Success { get; set; }

    /// <summary>失败原因</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>重试次数</summary>
    public int RetryCount { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
