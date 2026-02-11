using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Webhook 通知服务接口
/// </summary>
public interface IWebhookNotificationService
{
    /// <summary>
    /// 发送 Webhook 通知
    /// </summary>
    /// <param name="app">开放平台应用</param>
    /// <param name="type">通知类型</param>
    /// <param name="title">通知标题</param>
    /// <param name="content">通知内容模板，支持 {{value}} 占位符</param>
    /// <param name="values">占位符替换值列表</param>
    Task SendNotificationAsync(OpenPlatformApp app, string type, string title, string content, List<string>? values = null);

    /// <summary>
    /// 检查额度并在低于阈值时发送预警通知（fire-and-forget 安全调用）
    /// </summary>
    /// <param name="appId">应用 ID</param>
    /// <param name="tokensUsedInRequest">本次请求消耗的 token 数</param>
    Task CheckQuotaAndNotifyAsync(string appId, int tokensUsedInRequest);

    /// <summary>
    /// 发送测试 Webhook 通知
    /// </summary>
    Task<WebhookDeliveryLog> SendTestNotificationAsync(string webhookUrl, string? webhookSecret);

    /// <summary>
    /// 获取投递日志（分页）
    /// </summary>
    Task<(List<WebhookDeliveryLog> logs, long total)> GetDeliveryLogsAsync(string appId, int page, int pageSize);
}
