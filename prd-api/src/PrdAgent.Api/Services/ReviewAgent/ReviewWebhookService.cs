using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReviewAgent;

/// <summary>
/// 产品评审员 Webhook 推送服务
/// </summary>
public class ReviewWebhookService
{
    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<ReviewWebhookService> _logger;
    private readonly string? _frontendBaseUrl;

    public ReviewWebhookService(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        ILogger<ReviewWebhookService> logger,
        IConfiguration configuration)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _frontendBaseUrl = configuration["App:FrontendBaseUrl"]?.TrimEnd('/');
    }

    /// <summary>评审完成后推送通知</summary>
    public async Task NotifyReviewCompletedAsync(ReviewSubmission submission, int totalScore, bool isPassed, string summary)
    {
        try
        {
            var configs = await _db.ReviewWebhookConfigs
                .Find(w => w.IsEnabled && w.TriggerEvents.Contains(ReviewEventType.ReviewCompleted))
                .ToListAsync(CancellationToken.None);

            if (configs.Count == 0) return;

            var passText = isPassed ? "已通过" : "未通过";
            var title = "方案评审完成";

            // 纯文本内容（不含 Markdown 语法），BuildPayload 按渠道自行加格式
            var plainBody = $"方案：《{submission.Title}》\n" +
                            $"提交人：{submission.SubmitterName}\n" +
                            $"得分：{totalScore} / 100 分　{passText}\n" +
                            $"总评：{summary}";

            string? linkPath = null;
            if (!string.IsNullOrEmpty(_frontendBaseUrl))
                linkPath = $"{_frontendBaseUrl}/review-agent/submissions/{submission.Id}";

            var client = _httpClientFactory.CreateClient("webhook");
            client.Timeout = TimeSpan.FromSeconds(10);

            foreach (var config in configs)
            {
                await SendWebhookAsync(client, config, title, plainBody, linkPath, config.MentionAll);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[review-agent] Webhook notify failed for submission {Id}", submission.Id);
        }
    }

    /// <summary>发送测试消息</summary>
    public async Task<(bool Success, string? Error)> SendTestAsync(string webhookUrl, string channel, bool mentionAll = false)
    {
        try
        {
            var client = _httpClientFactory.CreateClient("webhook");
            client.Timeout = TimeSpan.FromSeconds(10);

            var payload = BuildPayload(channel, "Webhook 测试消息",
                "如果您看到这条消息，说明产品评审员 Webhook 配置正确。", null, mentionAll);
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

    private async Task SendWebhookAsync(HttpClient client, ReviewWebhookConfig config, string title, string body, string? link, bool mentionAll = false)
    {
        const int maxRetries = 3;

        for (var attempt = 1; attempt <= maxRetries; attempt++)
        {
            try
            {
                var payload = BuildPayload(config.Channel, title, body, link, mentionAll);
                var content = new StringContent(payload, Encoding.UTF8, "application/json");
                var response = await client.PostAsync(config.WebhookUrl, content);

                if (response.IsSuccessStatusCode)
                {
                    _logger.LogDebug("[review-agent] Webhook sent: {Channel}", config.Channel);
                    return;
                }

                _logger.LogWarning("[review-agent] Webhook failed (attempt {Attempt}): HTTP {StatusCode}",
                    attempt, (int)response.StatusCode);
            }
            catch (Exception ex) when (attempt < maxRetries)
            {
                _logger.LogWarning(ex, "[review-agent] Webhook attempt {Attempt} failed", attempt);
                await Task.Delay(TimeSpan.FromSeconds(attempt * 2));
            }
        }
    }

    private static string BuildPayload(string channel, string title, string body, string? link, bool mentionAll = false)
    {
        // body 是纯文本（不含 Markdown 语法），各渠道自行加格式

        // 企微：开启 @所有人 时用 text 类型（markdown 类型不支持 @）
        if (channel == WebhookChannel.WeCom && mentionAll)
        {
            var plainText = $"【{title}】\n{body}";
            if (!string.IsNullOrEmpty(link))
                plainText += $"\n查看详情：{link}";
            return JsonSerializer.Serialize(new
            {
                msgtype = "text",
                text = new
                {
                    content = plainText,
                    mentioned_list = new[] { "@all" },
                }
            });
        }

        // 为 Markdown 渠道加粗字段标签
        var mdBody = body
            .Replace("方案：", "**方案**：")
            .Replace("提交人：", "**提交人**：")
            .Replace("得分：", "**得分**：")
            .Replace("总评：", "**总评**：");
        var markdown = $"## {title}\n{mdBody}";
        if (!string.IsNullOrEmpty(link))
            markdown += $"\n> [查看详情]({link})";

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
                actionCard = new { title, text = markdown, singleTitle = "查看详情", singleURL = link ?? "" }
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
            _ => JsonSerializer.Serialize(new { event_type = title, content = body, link }),
        };
    }
}
