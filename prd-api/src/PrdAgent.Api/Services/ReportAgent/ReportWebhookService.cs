using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 周报事件 Webhook 推送服务
/// </summary>
public class ReportWebhookService
{
    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<ReportWebhookService> _logger;
    private readonly string? _frontendBaseUrl;

    public ReportWebhookService(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        ILogger<ReportWebhookService> logger,
        IConfiguration configuration)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _frontendBaseUrl = configuration["App:FrontendBaseUrl"]?.TrimEnd('/');
    }

    /// <summary>发送周报事件通知到配置的 Webhook</summary>
    public async Task NotifyAsync(string teamId, string eventType, string title, string body, string? linkPath = null)
    {
        try
        {
            // 将相对路径转换为完整 URL；如果没配置前端基地址则不生成链接
            string? fullLink = null;
            if (!string.IsNullOrEmpty(linkPath) && !string.IsNullOrEmpty(_frontendBaseUrl))
            {
                fullLink = $"{_frontendBaseUrl}{linkPath}";
            }
            var filter = Builders<ReportWebhookConfig>.Filter.And(
                Builders<ReportWebhookConfig>.Filter.Eq(x => x.TeamId, teamId),
                Builders<ReportWebhookConfig>.Filter.Eq(x => x.IsEnabled, true),
                Builders<ReportWebhookConfig>.Filter.AnyEq(x => x.TriggerEvents, eventType)
            );

            var configs = await _db.ReportWebhookConfigs
                .Find(filter)
                .ToListAsync(CancellationToken.None);

            if (configs.Count == 0) return;

            var client = _httpClientFactory.CreateClient("webhook");
            client.Timeout = TimeSpan.FromSeconds(10);

            foreach (var config in configs)
            {
                await SendWebhookAsync(client, config, eventType, title, body, fullLink);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[report-agent] Webhook notify failed for team {TeamId}, event {EventType}",
                teamId, eventType);
        }
    }

    /// <summary>发送测试消息</summary>
    public async Task<(bool Success, string? Error)> SendTestAsync(string webhookUrl, string channel)
    {
        try
        {
            var client = _httpClientFactory.CreateClient("webhook");
            client.Timeout = TimeSpan.FromSeconds(10);

            var title = "Webhook 测试消息";
            var body = "如果您看到这条消息，说明 Webhook 配置正确。";
            var payload = BuildPayload(channel, title, body, null);
            var content = new StringContent(payload, Encoding.UTF8, "application/json");
            var response = await client.PostAsync(webhookUrl, content);

            if (response.IsSuccessStatusCode)
                return (true, null);

            var responseBody = await response.Content.ReadAsStringAsync();
            return (false, $"HTTP {(int)response.StatusCode}: {responseBody[..Math.Min(responseBody.Length, 200)]}");
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    private async Task SendWebhookAsync(
        HttpClient client, ReportWebhookConfig config,
        string eventType, string title, string body, string? linkPath)
    {
        const int maxRetries = 3;
        string? lastError = null;
        int? lastStatusCode = null;
        var sw = System.Diagnostics.Stopwatch.StartNew();

        for (var attempt = 1; attempt <= maxRetries; attempt++)
        {
            try
            {
                var payload = BuildPayload(config.Channel, title, body, linkPath);
                var content = new StringContent(payload, Encoding.UTF8, "application/json");
                var response = await client.PostAsync(config.WebhookUrl, content);

                sw.Stop();

                if (response.IsSuccessStatusCode)
                {
                    await LogDeliveryAsync(config, eventType, title, payload, (int)response.StatusCode, null, sw.ElapsedMilliseconds, true, null, attempt - 1);
                    _logger.LogDebug("[report-agent] Webhook sent: {Channel} for team {TeamId} event {EventType}",
                        config.Channel, config.TeamId, eventType);
                    return;
                }

                lastStatusCode = (int)response.StatusCode;
                lastError = $"HTTP {lastStatusCode}";
                _logger.LogWarning("[report-agent] Webhook failed (attempt {Attempt}): HTTP {StatusCode}",
                    attempt, lastStatusCode);
            }
            catch (Exception ex) when (attempt < maxRetries)
            {
                lastError = ex.Message;
                _logger.LogWarning(ex, "[report-agent] Webhook attempt {Attempt} failed", attempt);
                await Task.Delay(TimeSpan.FromSeconds(attempt * 2));
            }
        }

        sw.Stop();
        await LogDeliveryAsync(config, eventType, title, null, lastStatusCode, null, sw.ElapsedMilliseconds, false, lastError, maxRetries);
    }

    private async Task LogDeliveryAsync(
        ReportWebhookConfig config, string eventType, string title,
        string? requestBody, int? statusCode, string? responseBody,
        long durationMs, bool success, string? errorMessage, int retryCount)
    {
        try
        {
            var log = new WebhookDeliveryLog
            {
                AppId = "report-agent",
                Type = eventType,
                Title = title,
                WebhookUrl = config.WebhookUrl,
                RequestBody = requestBody?[..Math.Min(requestBody.Length, 2048)],
                StatusCode = statusCode,
                ResponseBody = responseBody?[..Math.Min(responseBody.Length, 2048)],
                DurationMs = durationMs,
                Success = success,
                ErrorMessage = errorMessage,
                RetryCount = retryCount,
            };

            await _db.WebhookDeliveryLogs.InsertOneAsync(log, cancellationToken: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[report-agent] Failed to log webhook delivery");
        }
    }

    private static string BuildPayload(string channel, string title, string body, string? linkPath)
    {
        var markdown = $"## {title}\n{body}";
        if (!string.IsNullOrEmpty(linkPath))
        {
            markdown += $"\n> [查看详情]({linkPath})";
        }

        return channel switch
        {
            WebhookChannel.WeCom => JsonSerializer.Serialize(new
            {
                msgtype = "markdown",
                markdown = new { content = markdown }
            }),
            WebhookChannel.DingTalk => JsonSerializer.Serialize(new
            {
                msgtype = "actionCard",
                actionCard = new
                {
                    title,
                    text = markdown,
                    singleTitle = "查看详情",
                    singleURL = linkPath ?? "/report-agent",
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
                        new { tag = "div", text = new { tag = "lark_md", content = body } }
                    }
                }
            }),
            _ => JsonSerializer.Serialize(new
            {
                event_type = title,
                content = body,
                link = linkPath,
            }),
        };
    }
}
