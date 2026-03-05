using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 缺陷事件 Webhook 推送服务
/// </summary>
public class DefectWebhookService
{
    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<DefectWebhookService> _logger;

    public DefectWebhookService(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        ILogger<DefectWebhookService> logger)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    /// <summary>发送缺陷事件通知到配置的 Webhook</summary>
    public async Task NotifyAsync(DefectReport defect, string eventType)
    {
        try
        {
            // 查找匹配的 webhook 配置
            var filter = Builders<DefectWebhookConfig>.Filter.And(
                Builders<DefectWebhookConfig>.Filter.Eq(x => x.IsEnabled, true),
                Builders<DefectWebhookConfig>.Filter.AnyEq(x => x.TriggerEvents, eventType),
                Builders<DefectWebhookConfig>.Filter.Or(
                    // 全局配置
                    Builders<DefectWebhookConfig>.Filter.And(
                        Builders<DefectWebhookConfig>.Filter.Eq(x => x.TeamId, (string?)null),
                        Builders<DefectWebhookConfig>.Filter.Eq(x => x.ProjectId, (string?)null)
                    ),
                    // 匹配团队
                    Builders<DefectWebhookConfig>.Filter.Eq(x => x.TeamId, defect.TeamId),
                    // 匹配项目
                    Builders<DefectWebhookConfig>.Filter.Eq(x => x.ProjectId, defect.ProjectId)
                )
            );

            var configs = await _db.DefectWebhookConfigs
                .Find(filter)
                .ToListAsync(CancellationToken.None);

            if (configs.Count == 0) return;

            var client = _httpClientFactory.CreateClient("webhook");
            client.Timeout = TimeSpan.FromSeconds(10);

            foreach (var config in configs)
            {
                await SendWebhookAsync(client, config, defect, eventType);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[defect-agent] Webhook notify failed for defect {DefectNo}, event {EventType}",
                defect.DefectNo, eventType);
        }
    }

    private async Task SendWebhookAsync(HttpClient client, DefectWebhookConfig config, DefectReport defect, string eventType)
    {
        const int maxRetries = 3;

        for (var attempt = 1; attempt <= maxRetries; attempt++)
        {
            try
            {
                var payload = BuildPayload(config.Channel, defect, eventType);
                var content = new StringContent(payload, Encoding.UTF8, "application/json");
                var response = await client.PostAsync(config.WebhookUrl, content);

                if (response.IsSuccessStatusCode)
                {
                    _logger.LogDebug("[defect-agent] Webhook sent: {Channel} for {DefectNo} event {EventType}",
                        config.Channel, defect.DefectNo, eventType);
                    return;
                }

                _logger.LogWarning("[defect-agent] Webhook failed (attempt {Attempt}): HTTP {StatusCode}",
                    attempt, (int)response.StatusCode);
            }
            catch (Exception ex) when (attempt < maxRetries)
            {
                _logger.LogWarning(ex, "[defect-agent] Webhook attempt {Attempt} failed", attempt);
                await Task.Delay(TimeSpan.FromSeconds(attempt * 2));
            }
        }
    }

    private static string BuildPayload(string channel, DefectReport defect, string eventType)
    {
        var eventLabel = eventType switch
        {
            DefectEventType.Submitted => "新缺陷提交",
            DefectEventType.Assigned => "缺陷已指派",
            DefectEventType.Escalated => "缺陷催办",
            DefectEventType.Resolved => "缺陷已解决",
            DefectEventType.Closed => "缺陷已关闭",
            DefectEventType.VerifyFailed => "验收不通过",
            _ => eventType,
        };

        var title = $"[{eventLabel}] {defect.DefectNo}: {defect.Title ?? "无标题"}";
        var body = $"严重程度: {defect.Severity ?? "-"}\n" +
                   $"报告人: {defect.ReporterName ?? "-"}\n" +
                   $"处理人: {defect.AssigneeName ?? "未指派"}\n" +
                   $"项目: {defect.ProjectName ?? "未分类"}";

        return channel switch
        {
            WebhookChannel.WeCom => JsonSerializer.Serialize(new
            {
                msgtype = "markdown",
                markdown = new { content = $"## {title}\n{body}" }
            }),
            WebhookChannel.DingTalk => JsonSerializer.Serialize(new
            {
                msgtype = "actionCard",
                actionCard = new
                {
                    title,
                    text = $"## {title}\n{body}",
                    singleTitle = "查看详情",
                    singleURL = $"/defect-agent?id={defect.Id}",
                }
            }),
            WebhookChannel.Feishu => JsonSerializer.Serialize(new
            {
                msg_type = "interactive",
                card = new
                {
                    header = new { title = new { tag = "plain_text", content = title } },
                    elements = new object[]
                    {
                        new { tag = "div", text = new { tag = "plain_text", content = body } }
                    }
                }
            }),
            _ => JsonSerializer.Serialize(new
            {
                event_type = eventType,
                defect_no = defect.DefectNo,
                title = defect.Title,
                severity = defect.Severity,
                status = defect.Status,
                reporter = defect.ReporterName,
                assignee = defect.AssigneeName,
                project = defect.ProjectName,
            }),
        };
    }
}
