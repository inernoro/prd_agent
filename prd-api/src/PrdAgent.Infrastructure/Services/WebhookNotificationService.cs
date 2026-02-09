using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// Webhook 通知服务实现
/// </summary>
public class WebhookNotificationService : IWebhookNotificationService
{
    private readonly MongoDbContext _db;
    private readonly IOpenPlatformService _openPlatformService;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IAutomationHub _automationHub;
    private readonly ILogger<WebhookNotificationService> _logger;

    /// <summary>预警通知最小间隔（避免频繁通知）</summary>
    private static readonly TimeSpan QuotaWarningCooldown = TimeSpan.FromHours(1);

    /// <summary>最大重试次数</summary>
    private const int MaxRetries = 3;

    public WebhookNotificationService(
        MongoDbContext db,
        IOpenPlatformService openPlatformService,
        IHttpClientFactory httpClientFactory,
        IAutomationHub automationHub,
        ILogger<WebhookNotificationService> logger)
    {
        _db = db;
        _openPlatformService = openPlatformService;
        _httpClientFactory = httpClientFactory;
        _automationHub = automationHub;
        _logger = logger;
    }

    public async Task SendNotificationAsync(
        OpenPlatformApp app,
        string type,
        string title,
        string content,
        List<string>? values = null)
    {
        // 替换 {{value}} 占位符
        var resolvedContent = ResolveContentPlaceholders(content, values);

        // 1) 外部 Webhook 投递
        if (!string.IsNullOrWhiteSpace(app.WebhookUrl))
        {
            var payload = new
            {
                type,
                title,
                content = resolvedContent,
                values = values ?? new List<string>(),
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
            };

            var payloadJson = JsonSerializer.Serialize(payload, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });

            var deliveryLog = await DeliverWebhookAsync(app.Id, app.WebhookUrl, app.WebhookSecret, type, title, payloadJson);

            // 保存投递日志
            try
            {
                await _db.WebhookDeliveryLogs.InsertOneAsync(deliveryLog);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to save webhook delivery log for app {AppId}", app.Id);
            }
        }

        // 2) 站内信通知
        await CreateAdminNotificationAsync(app, type, title, resolvedContent);
    }

    public async Task CheckQuotaAndNotifyAsync(string appId, int tokensUsedInRequest)
    {
        try
        {
            if (tokensUsedInRequest <= 0) return;

            var app = await _openPlatformService.GetAppByIdAsync(appId);
            if (app == null) return;

            // 未启用 webhook 或未配置 URL，跳过
            if (!app.WebhookEnabled || string.IsNullOrWhiteSpace(app.WebhookUrl)) return;

            // 未设置额度上限，跳过
            if (app.TokenQuotaLimit <= 0) return;

            // 累加 token 使用量
            var update = Builders<OpenPlatformApp>.Update
                .Inc(a => a.TokensUsed, tokensUsedInRequest);
            await _db.OpenPlatformApps.UpdateOneAsync(a => a.Id == appId, update);

            // 计算剩余额度
            var newTokensUsed = app.TokensUsed + tokensUsedInRequest;
            var remaining = app.TokenQuotaLimit - newTokensUsed;

            // 检查是否低于预警阈值
            if (remaining > app.QuotaWarningThreshold) return;

            // 检查冷却时间（避免频繁通知）
            if (app.LastQuotaWarningAt.HasValue &&
                DateTime.UtcNow - app.LastQuotaWarningAt.Value < QuotaWarningCooldown)
            {
                return;
            }

            // 更新最后预警时间
            var updateWarning = Builders<OpenPlatformApp>.Update
                .Set(a => a.LastQuotaWarningAt, DateTime.UtcNow);
            await _db.OpenPlatformApps.UpdateOneAsync(a => a.Id == appId, updateWarning);

            // 计算等价金额（估算：100000 tokens ≈ $0.20）
            var remainingDollars = remaining * 0.20m / 100000m;
            var remainingDisplay = remainingDollars >= 0
                ? $"${remainingDollars:F2}"
                : "$0.00";

            // 发送预警通知（直接渠道：app 自身配置的 webhook + 站内信）
            await SendNotificationAsync(
                app,
                type: "quota_exceed",
                title: "额度预警通知",
                content: "您的额度即将用尽，当前剩余额度 {{value}}",
                values: new List<string> { remainingDisplay });

            // 发布到自动化中枢（匹配所有相关规则）
            _ = _automationHub.PublishEventAsync(
                eventType: "open-platform.quota.warning",
                title: "额度预警通知",
                content: "应用「{{value}}」额度即将用尽，当前剩余额度 {{value}}",
                values: new List<string> { app.AppName, remainingDisplay },
                sourceId: app.Id);
        }
        catch (Exception ex)
        {
            // fire-and-forget: 通知失败不应影响主请求流程
            _logger.LogError(ex, "Failed to check quota and notify for app {AppId}", appId);
        }
    }

    public async Task<WebhookDeliveryLog> SendTestNotificationAsync(string webhookUrl, string? webhookSecret)
    {
        var payload = new
        {
            type = "test",
            title = "Webhook 连通性测试",
            content = "这是一条测试通知，如果您收到此消息说明 Webhook 配置正确。",
            values = Array.Empty<string>(),
            timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        };

        var payloadJson = JsonSerializer.Serialize(payload, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });

        var deliveryLog = await DeliverWebhookAsync("test", webhookUrl, webhookSecret, "test", "Webhook 连通性测试", payloadJson);
        return deliveryLog;
    }

    public async Task<(List<WebhookDeliveryLog> logs, long total)> GetDeliveryLogsAsync(string appId, int page, int pageSize)
    {
        var filter = Builders<WebhookDeliveryLog>.Filter.Eq(l => l.AppId, appId);
        var total = await _db.WebhookDeliveryLogs.CountDocumentsAsync(filter);
        var skip = (page - 1) * pageSize;

        var logs = await _db.WebhookDeliveryLogs
            .Find(filter)
            .SortByDescending(l => l.CreatedAt)
            .Skip(skip)
            .Limit(pageSize)
            .ToListAsync();

        return (logs, total);
    }

    /// <summary>
    /// 执行 Webhook HTTP 投递（含重试）
    /// </summary>
    private async Task<WebhookDeliveryLog> DeliverWebhookAsync(
        string appId,
        string webhookUrl,
        string? webhookSecret,
        string type,
        string title,
        string payloadJson)
    {
        var log = new WebhookDeliveryLog
        {
            AppId = appId,
            Type = type,
            Title = title,
            WebhookUrl = webhookUrl,
            RequestBody = payloadJson,
        };

        var sw = Stopwatch.StartNew();
        var retryCount = 0;

        while (retryCount <= MaxRetries)
        {
            try
            {
                var client = _httpClientFactory.CreateClient("WebhookClient");
                client.Timeout = TimeSpan.FromSeconds(10);

                var request = new HttpRequestMessage(HttpMethod.Post, webhookUrl)
                {
                    Content = new StringContent(payloadJson, Encoding.UTF8, "application/json")
                };

                // 添加 Bearer 认证
                if (!string.IsNullOrWhiteSpace(webhookSecret))
                {
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", webhookSecret);
                }

                var response = await client.SendAsync(request);
                var responseBody = await response.Content.ReadAsStringAsync();

                log.StatusCode = (int)response.StatusCode;
                log.ResponseBody = responseBody.Length > 2048 ? responseBody[..2048] : responseBody;
                log.Success = response.IsSuccessStatusCode;
                log.DurationMs = sw.ElapsedMilliseconds;
                log.RetryCount = retryCount;

                if (response.IsSuccessStatusCode)
                {
                    break;
                }

                // 4xx 错误不重试（客户端错误）
                if ((int)response.StatusCode >= 400 && (int)response.StatusCode < 500)
                {
                    log.ErrorMessage = $"HTTP {(int)response.StatusCode}: {responseBody[..Math.Min(200, responseBody.Length)]}";
                    break;
                }

                // 5xx 重试
                retryCount++;
                if (retryCount <= MaxRetries)
                {
                    await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, retryCount)));
                }
            }
            catch (Exception ex)
            {
                log.Success = false;
                log.ErrorMessage = ex.Message;
                log.DurationMs = sw.ElapsedMilliseconds;
                log.RetryCount = retryCount;

                retryCount++;
                if (retryCount <= MaxRetries)
                {
                    await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, retryCount)));
                }
            }
        }

        return log;
    }

    /// <summary>
    /// 替换内容模板中的 {{value}} 占位符
    /// </summary>
    private static string ResolveContentPlaceholders(string content, List<string>? values)
    {
        if (string.IsNullOrEmpty(content) || values == null || values.Count == 0)
            return content;

        var result = content;
        foreach (var value in values)
        {
            var idx = result.IndexOf("{{value}}", StringComparison.Ordinal);
            if (idx < 0) break;
            result = result[..idx] + value + result[(idx + "{{value}}".Length)..];
        }
        return result;
    }

    /// <summary>
    /// 根据 NotifyTarget 配置创建站内信通知
    /// </summary>
    private async Task CreateAdminNotificationAsync(
        OpenPlatformApp app,
        string type,
        string title,
        string resolvedContent)
    {
        try
        {
            var notifyTarget = app.NotifyTarget ?? "none";
            if (notifyTarget == "none") return;

            // 通知级别映射
            var level = type switch
            {
                "quota_exceed" => "warning",
                "test" => "info",
                _ => "info"
            };

            var notification = new AdminNotification
            {
                Key = $"open-platform:{app.Id}:{type}:{DateTime.UtcNow:yyyyMMddHH}",
                TargetUserId = notifyTarget == "owner" ? app.BoundUserId : null,
                Title = $"[{app.AppName}] {title}",
                Message = resolvedContent,
                Level = level,
                Source = "open-platform",
                ExpiresAt = DateTime.UtcNow.AddDays(7)
            };

            // 幂等插入：如果 Key 已存在则跳过
            var existing = await _db.AdminNotifications
                .Find(n => n.Key == notification.Key)
                .FirstOrDefaultAsync();

            if (existing == null)
            {
                await _db.AdminNotifications.InsertOneAsync(notification);
                _logger.LogInformation(
                    "Created admin notification for app {AppId}, type={Type}, target={Target}",
                    app.Id, type, notifyTarget);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create admin notification for app {AppId}", app.Id);
        }
    }
}
