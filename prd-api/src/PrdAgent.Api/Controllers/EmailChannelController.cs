using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services.Channels;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using MimeKit;
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
    [VerifyRawEmailBody]
    [RequestSizeLimit(SendGridInboundAuthentication.MaxBodyBytes)]
    [Consumes("multipart/form-data", "application/x-www-form-urlencoded")]
    public async Task<IActionResult> ReceiveInbound(CancellationToken ct)
    {
        try
        {
            // A Parse-specific security policy is mandatory, including when configuration is absent.
            var verified = await SendGridInboundAuthentication.ValidateAsync(Request, _configuration, ct);
            if (verified == null) return Unauthorized();

            var form = await Request.ReadFormAsync(ct);
            // SMTP envelope recipient, not the sender-controlled To header, selects the channel.
            if (form["envelope"].Count != 1) return BadRequest();
            using var envelope = JsonDocument.Parse(form["envelope"].ToString());
            if (envelope.RootElement.ValueKind != JsonValueKind.Object
                || !envelope.RootElement.TryGetProperty("to", out var recipients)
                || recipients.ValueKind != JsonValueKind.Array || recipients.GetArrayLength() != 1
                || recipients[0].ValueKind != JsonValueKind.String
                || !string.Equals(recipients[0].GetString(), verified.Recipient, StringComparison.OrdinalIgnoreCase))
                return Unauthorized();
            // This endpoint accepts parsed fields; raw MIME mode is a different Parse contract.
            if (form.ContainsKey("email")) return BadRequest();

            var fromRaw = form["from"].ToString();
            var to = form["to"].ToString();
            var subject = form["subject"].ToString();
            var text = form["text"].ToString();
            var html = form["html"].ToString();
            // SendGrid places Message-ID inside the original RFC mail headers.
            string? messageId = null;
            if (form["headers"].Count > 1) return BadRequest();
            if (!string.IsNullOrWhiteSpace(form["headers"].ToString()))
            {
                using var headerStream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(form["headers"].ToString() + "\r\n\r\n"));
                var headers = HeaderList.Load(headerStream);
                if (headers.Count(h => h.Id == HeaderId.MessageId) > 1) return BadRequest();
                messageId = headers[HeaderId.MessageId]?.Trim();
            }
            var deliveryKey = string.IsNullOrWhiteSpace(messageId)
                ? "content:" + await HashParsedEmailAsync(form, ct) : "message:" + messageId;

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
                ["envelopeRecipient"] = verified.Recipient,
                ["provider"] = "sendgrid-inbound-parse",
                ["messageId"] = messageId ?? string.Empty,
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
                ct,
                new VerifiedEmailIngress(verified.Recipient, verified.OwnerUserId, deliveryKey));

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
        catch (Exception ex) when (ex is JsonException or FormatException or InvalidDataException)
        {
            return BadRequest();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing email inbound webhook");
            // Transient persistence failures must be retried; deterministic IDs make retries safe.
            return StatusCode(StatusCodes.Status503ServiceUnavailable);
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
        // The former Development-only route bypassed provider authentication and ownership.
        // Use signed raw request fixtures against /inbound for local tests.
        await Task.CompletedTask;
        return NotFound();
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

    // Boundary strings are transport metadata and may change on a provider retry. For mail
    // without Message-ID, hash authenticated form values and attachment bytes with framing.
    private static async Task<string> HashParsedEmailAsync(IFormCollection form, CancellationToken ct)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        void AppendDescriptor(object value) => hash.AppendData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value) + "\n"));
        foreach (var field in form.OrderBy(x => x.Key, StringComparer.Ordinal))
            AppendDescriptor(new { field.Key, Values = field.Value.ToArray() });
        foreach (var file in form.Files.OrderBy(x => x.Name, StringComparer.Ordinal).ThenBy(x => x.FileName, StringComparer.Ordinal))
        {
            AppendDescriptor(new { file.Name, file.FileName, file.ContentType, file.Length });
            using var stream = file.OpenReadStream();
            var buffer = new byte[64 * 1024];
            int count;
            while ((count = await stream.ReadAsync(buffer, ct)) > 0) hash.AppendData(buffer, 0, count);
        }
        return Convert.ToHexString(hash.GetHashAndReset());
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
