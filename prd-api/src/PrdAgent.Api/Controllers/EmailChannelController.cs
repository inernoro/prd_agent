using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.Channels;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 邮件通道控制器（接收入站 Webhook）
/// </summary>
[ApiController]
[Route("api/channels/email")]
public class EmailChannelController : ControllerBase
{
    private readonly ChannelTaskService _taskService;
    private readonly ILogger<EmailChannelController> _logger;
    private readonly IConfiguration _configuration;

    public EmailChannelController(
        ChannelTaskService taskService,
        ILogger<EmailChannelController> logger,
        IConfiguration configuration)
    {
        _taskService = taskService;
        _logger = logger;
        _configuration = configuration;
    }

    /// <summary>
    /// 接收邮件入站 Webhook（SendGrid Inbound Parse 格式）
    /// </summary>
    /// <remarks>
    /// SendGrid 会以 multipart/form-data 格式发送数据
    /// 主要字段：from, to, subject, text, html, attachments
    /// </remarks>
    [HttpPost("inbound")]
    [Consumes("multipart/form-data", "application/x-www-form-urlencoded")]
    public async Task<IActionResult> ReceiveInbound(CancellationToken ct)
    {
        try
        {
            // 1. 验证 Webhook 签名（如果配置了）
            var signingKey = _configuration["Channels:Email:SendGrid:WebhookSigningKey"];
            if (!string.IsNullOrWhiteSpace(signingKey))
            {
                // TODO: 实现 SendGrid 签名验证
                // var signature = Request.Headers["X-Twilio-Email-Event-Webhook-Signature"];
                // if (!ValidateSignature(signature, signingKey))
                // {
                //     _logger.LogWarning("Invalid webhook signature from {IP}", GetClientIp());
                //     return Unauthorized();
                // }
            }

            // 2. 解析邮件数据
            var form = await Request.ReadFormAsync(ct);

            var fromRaw = form["from"].ToString();
            var to = form["to"].ToString();
            var subject = form["subject"].ToString();
            var text = form["text"].ToString();
            var html = form["html"].ToString();
            var messageId = form["Message-Id"].ToString();

            // 解析发件人
            var (fromEmail, fromName) = ParseEmailAddress(fromRaw);

            if (string.IsNullOrWhiteSpace(fromEmail))
            {
                _logger.LogWarning("Invalid from address: {From}", fromRaw);
                return Ok(); // 静默丢弃
            }

            _logger.LogInformation("Email received from {From} ({Name}) subject: {Subject}",
                fromEmail, fromName, subject);

            // 3. 处理附件
            var attachments = new List<ChannelTaskAttachment>();
            foreach (var file in form.Files)
            {
                attachments.Add(new ChannelTaskAttachment
                {
                    FileName = file.FileName,
                    FileSize = file.Length,
                    MimeType = file.ContentType,
                    // TODO: 上传附件到存储并设置 Url
                });
            }

            // 4. 创建任务
            var content = !string.IsNullOrWhiteSpace(text) ? text : StripHtml(html);
            var metadata = new Dictionary<string, object>
            {
                ["to"] = to,
                ["messageId"] = messageId,
                ["hasHtml"] = !string.IsNullOrWhiteSpace(html),
                ["clientIp"] = GetClientIp()
            };

            var result = await _taskService.CreateTaskAsync(
                ChannelTypes.Email,
                fromEmail,
                fromName,
                subject,
                content,
                messageId,
                attachments,
                metadata,
                ct);

            if (result.Success)
            {
                _logger.LogInformation("Task created: {TaskId} for email from {From}",
                    result.Task!.Id, fromEmail);

                // TODO: 发送确认邮件
                // await SendTaskReceivedEmailAsync(result.Task, ct);
            }
            else
            {
                _logger.LogInformation("Email rejected from {From}: {Reason}",
                    fromEmail, result.RejectReason);
                // 静默丢弃，不回复
            }

            // 返回 200 确认收到（无论是否创建任务）
            return Ok();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing email inbound webhook");
            // 返回 200 避免 SendGrid 重试
            return Ok();
        }
    }

    /// <summary>
    /// 接收邮件发送状态回调
    /// </summary>
    [HttpPost("status")]
    public IActionResult ReceiveStatus()
    {
        // TODO: 处理邮件发送状态回调（delivered, bounced, etc.）
        return Ok();
    }

    /// <summary>
    /// 模拟邮件入站（用于测试）
    /// </summary>
    [HttpPost("inbound/test")]
    public async Task<IActionResult> TestInbound([FromBody] TestEmailInboundRequest request, CancellationToken ct)
    {
        var env = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT");
        if (env != "Development")
        {
            return NotFound();
        }

        var result = await _taskService.CreateTaskAsync(
            ChannelTypes.Email,
            request.From,
            request.FromName,
            request.Subject,
            request.Text,
            request.MessageId ?? $"test-{Guid.NewGuid():N}@localhost",
            null,
            new Dictionary<string, object> { ["test"] = true },
            ct);

        if (result.Success)
        {
            return Ok(ApiResponse<ChannelTask>.Ok(result.Task!));
        }

        return BadRequest(ApiResponse<object>.Fail(result.RejectReason!, result.RejectReasonDisplay!));
    }

    #region Helper Methods

    /// <summary>
    /// 解析邮件地址（格式：Name <email@example.com> 或 email@example.com）
    /// </summary>
    private static (string? Email, string? Name) ParseEmailAddress(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return (null, null);
        }

        // 格式：Name <email@example.com>
        var match = System.Text.RegularExpressions.Regex.Match(raw, @"(?:""?([^""<]+)""?\s*)?<([^>]+)>");
        if (match.Success)
        {
            return (match.Groups[2].Value.Trim().ToLowerInvariant(), match.Groups[1].Value.Trim());
        }

        // 纯邮箱
        var emailMatch = System.Text.RegularExpressions.Regex.Match(raw, @"[\w.+-]+@[\w.-]+\.\w+");
        if (emailMatch.Success)
        {
            return (emailMatch.Value.ToLowerInvariant(), null);
        }

        return (null, null);
    }

    /// <summary>
    /// 简单去除 HTML 标签
    /// </summary>
    private static string StripHtml(string? html)
    {
        if (string.IsNullOrWhiteSpace(html))
        {
            return string.Empty;
        }

        // 移除 HTML 标签
        var text = System.Text.RegularExpressions.Regex.Replace(html, @"<[^>]+>", " ");
        // 解码 HTML 实体
        text = System.Net.WebUtility.HtmlDecode(text);
        // 规范化空白
        text = System.Text.RegularExpressions.Regex.Replace(text, @"\s+", " ");
        return text.Trim();
    }

    private string GetClientIp()
    {
        return HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    }

    #endregion
}

/// <summary>
/// 测试邮件入站请求
/// </summary>
public class TestEmailInboundRequest
{
    public string From { get; set; } = string.Empty;
    public string? FromName { get; set; }
    public string? Subject { get; set; }
    public string Text { get; set; } = string.Empty;
    public string? MessageId { get; set; }
}
