using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Automation;

/// <summary>
/// Webhook 动作执行器：HTTP POST 到外部 URL
/// </summary>
public class WebhookActionExecutor : IActionExecutor
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly MongoDbContext _db;
    private readonly ILogger<WebhookActionExecutor> _logger;

    private const int MaxRetries = 3;

    public string ActionType => "webhook";

    public WebhookActionExecutor(
        IHttpClientFactory httpClientFactory,
        MongoDbContext db,
        ILogger<WebhookActionExecutor> logger)
    {
        _httpClientFactory = httpClientFactory;
        _db = db;
        _logger = logger;
    }

    public async Task<ActionExecuteResult> ExecuteAsync(
        AutomationRule rule,
        AutomationAction action,
        AutomationEventPayload payload)
    {
        if (string.IsNullOrWhiteSpace(action.WebhookUrl))
        {
            return new ActionExecuteResult
            {
                Success = false,
                ErrorMessage = "Webhook URL is not configured"
            };
        }

        var body = new
        {
            type = payload.EventType,
            title = payload.Title,
            content = payload.Content,
            values = payload.Values ?? new List<string>(),
            timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        };

        var payloadJson = JsonSerializer.Serialize(body, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        });

        var log = await DeliverAsync(rule.Id, action.WebhookUrl, action.WebhookSecret, payload.EventType, payload.Title, payloadJson);

        // 保存投递日志
        try
        {
            await _db.WebhookDeliveryLogs.InsertOneAsync(log);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to save webhook delivery log for rule {RuleId}", rule.Id);
        }

        return new ActionExecuteResult
        {
            Success = log.Success,
            ErrorMessage = log.ErrorMessage,
            Details = new Dictionary<string, object>
            {
                ["statusCode"] = log.StatusCode ?? 0,
                ["durationMs"] = log.DurationMs ?? 0,
                ["retryCount"] = log.RetryCount
            }
        };
    }

    private async Task<WebhookDeliveryLog> DeliverAsync(
        string sourceId,
        string webhookUrl,
        string? webhookSecret,
        string type,
        string title,
        string payloadJson)
    {
        var log = new WebhookDeliveryLog
        {
            AppId = sourceId,
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

                if (response.IsSuccessStatusCode) break;

                if ((int)response.StatusCode >= 400 && (int)response.StatusCode < 500)
                {
                    log.ErrorMessage = $"HTTP {(int)response.StatusCode}: {responseBody[..Math.Min(200, responseBody.Length)]}";
                    break;
                }

                retryCount++;
                if (retryCount <= MaxRetries)
                    await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, retryCount)));
            }
            catch (Exception ex)
            {
                log.Success = false;
                log.ErrorMessage = ex.Message;
                log.DurationMs = sw.ElapsedMilliseconds;
                log.RetryCount = retryCount;

                retryCount++;
                if (retryCount <= MaxRetries)
                    await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, retryCount)));
            }
        }

        return log;
    }
}
