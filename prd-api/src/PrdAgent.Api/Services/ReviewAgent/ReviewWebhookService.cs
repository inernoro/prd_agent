using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
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
    private readonly ISafeOutboundUrlValidator _urlValidator;

    public ReviewWebhookService(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        ILogger<ReviewWebhookService> logger,
        IConfiguration configuration,
        ISafeOutboundUrlValidator urlValidator)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _urlValidator = urlValidator;
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
            // 去除 summary 中 LLM 自带的 * 号（Markdown 加粗语法）
            var cleanSummary = summary.Replace("*", "");
            var plainBody = $"方案：《{submission.Title}》\n" +
                            $"提交人：{submission.SubmitterName}\n" +
                            $"得分：{totalScore} / 100 分　{passText}\n" +
                            $"总评：{cleanSummary}";

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

    /// <summary>申诉相关 webhook 通知（提交 / 通过 / 驳回）</summary>
    public async Task NotifyAppealEventAsync(string eventType, ReviewSubmission submission, ReviewAppeal appeal)
    {
        try
        {
            var configs = await _db.ReviewWebhookConfigs
                .Find(w => w.IsEnabled && w.TriggerEvents.Contains(eventType))
                .ToListAsync(CancellationToken.None);

            if (configs.Count == 0) return;

            string title = eventType switch
            {
                ReviewEventType.AppealSubmitted => "评审申诉已提交（待审理）",
                ReviewEventType.AppealApproved => "评审申诉已通过",
                ReviewEventType.AppealRejected => "评审申诉已驳回",
                _ => "评审申诉状态变更",
            };

            // 富文本 reasonHtml 转纯文本预览（去 HTML 标签，截 80 字）
            var reasonPlain = StripHtml(appeal.ReasonHtml);
            if (reasonPlain.Length > 80) reasonPlain = reasonPlain[..80] + "…";

            var lines = new List<string>
            {
                $"方案：《{submission.Title}》",
                $"提交人：{submission.SubmitterName}",
                $"申诉理由：{reasonPlain}",
            };
            if (!string.IsNullOrWhiteSpace(appeal.ResolverComment))
                lines.Add($"受理意见：{appeal.ResolverComment}");
            if (!string.IsNullOrWhiteSpace(appeal.ResolverName))
                lines.Add($"受理人：{appeal.ResolverName}");
            var plainBody = string.Join('\n', lines);

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
            _logger.LogWarning(ex, "[review-agent] Appeal webhook notify failed for submission {Id} event {Event}",
                submission.Id, eventType);
        }
    }

    private static string StripHtml(string html)
    {
        if (string.IsNullOrEmpty(html)) return string.Empty;
        // 简单去标签：替换 <img> 为「[图片]」，其他标签直接删除
        var withImg = System.Text.RegularExpressions.Regex.Replace(html, @"<img\b[^>]*>", "[图片]", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var noTags = System.Text.RegularExpressions.Regex.Replace(withImg, @"<[^>]+>", "");
        // 解码常见 HTML 实体
        return System.Net.WebUtility.HtmlDecode(noTags).Trim();
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
            var safeUrl = await _urlValidator.EnsureSafeHttpUrlAsync(webhookUrl, "评审 Webhook 地址");
            var response = await client.PostAsync(safeUrl, content);

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
        var safeUrl = await _urlValidator.EnsureSafeHttpUrlAsync(config.WebhookUrl, "评审 Webhook 地址");

        for (var attempt = 1; attempt <= maxRetries; attempt++)
        {
            try
            {
                var payload = BuildPayload(config.Channel, title, body, link, mentionAll);
                var content = new StringContent(payload, Encoding.UTF8, "application/json");
                var response = await client.PostAsync(safeUrl, content);

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
