using MailKit;
using MailKit.Net.Imap;
using MailKit.Net.Smtp;
using MailKit.Search;
using MailKit.Security;
using Microsoft.Extensions.Logging;
using MimeKit;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 邮件通道服务实现
/// 使用 MailKit 进行 IMAP/SMTP 操作
/// </summary>
public class EmailChannelService : IEmailChannelService
{
    private readonly MongoDbContext _db;
    private readonly ILogger<EmailChannelService> _logger;

    public EmailChannelService(MongoDbContext db, ILogger<EmailChannelService> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<(bool Success, string Message)> TestImapConnectionAsync(
        string host,
        int port,
        string username,
        string password,
        bool useSsl,
        CancellationToken ct = default)
    {
        try
        {
            using var client = new ImapClient();

            var secureSocketOptions = useSsl ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTlsWhenAvailable;
            await client.ConnectAsync(host, port, secureSocketOptions, ct);
            await client.AuthenticateAsync(username, password, ct);

            // 尝试打开收件箱验证权限
            var inbox = client.Inbox;
            await inbox.OpenAsync(FolderAccess.ReadOnly, ct);
            var count = inbox.Count;

            await client.DisconnectAsync(true, ct);

            return (true, $"连接成功，收件箱有 {count} 封邮件");
        }
        catch (AuthenticationException ex)
        {
            _logger.LogWarning(ex, "IMAP authentication failed for {Host}", host);
            return (false, $"认证失败：{ex.Message}");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "IMAP connection failed for {Host}", host);
            return (false, $"连接失败：{ex.Message}");
        }
    }

    public async Task<int> PollEmailsAsync(CancellationToken ct = default)
    {
        var settings = await GetSettingsAsync(ct);
        if (settings == null || !settings.IsEnabled)
        {
            _logger.LogDebug("Email channel is disabled or not configured");
            return 0;
        }

        if (string.IsNullOrEmpty(settings.ImapHost) ||
            string.IsNullOrEmpty(settings.ImapUsername) ||
            string.IsNullOrEmpty(settings.ImapPassword))
        {
            _logger.LogWarning("IMAP settings incomplete");
            return 0;
        }

        try
        {
            using var client = new ImapClient();

            var secureSocketOptions = settings.ImapUseSsl
                ? SecureSocketOptions.SslOnConnect
                : SecureSocketOptions.StartTlsWhenAvailable;

            await client.ConnectAsync(settings.ImapHost, settings.ImapPort, secureSocketOptions, ct);
            await client.AuthenticateAsync(settings.ImapUsername, settings.ImapPassword, ct);

            var inbox = client.Inbox;
            await inbox.OpenAsync(FolderAccess.ReadWrite, ct);

            // 搜索未读邮件
            var uids = await inbox.SearchAsync(SearchQuery.NotSeen, ct);
            _logger.LogInformation("Found {Count} unread emails", uids.Count);

            var processedCount = 0;

            foreach (var uid in uids)
            {
                try
                {
                    var message = await inbox.GetMessageAsync(uid, ct);
                    await ProcessEmailAsync(message, settings, ct);

                    // 标记为已读
                    if (settings.MarkAsReadAfterProcess)
                    {
                        await inbox.AddFlagsAsync(uid, MessageFlags.Seen, true, ct);
                    }

                    processedCount++;
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to process email UID {Uid}", uid);
                }
            }

            await client.DisconnectAsync(true, ct);

            // 更新轮询状态
            await UpdatePollStatusAsync(true, null, processedCount, ct);

            return processedCount;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Email polling failed");
            await UpdatePollStatusAsync(false, ex.Message, 0, ct);
            throw;
        }
    }

    public async Task<bool> SendReplyAsync(
        string toAddress,
        string toName,
        string subject,
        string body,
        string? inReplyTo = null,
        CancellationToken ct = default)
    {
        var settings = await GetSettingsAsync(ct);
        if (settings == null)
        {
            _logger.LogWarning("SMTP settings not configured");
            return false;
        }

        if (string.IsNullOrEmpty(settings.SmtpHost) ||
            string.IsNullOrEmpty(settings.SmtpUsername) ||
            string.IsNullOrEmpty(settings.SmtpPassword))
        {
            _logger.LogWarning("SMTP settings incomplete");
            return false;
        }

        try
        {
            var message = new MimeMessage();
            message.From.Add(new MailboxAddress(
                settings.SmtpFromName ?? "PRD Agent",
                settings.SmtpFromAddress ?? settings.SmtpUsername));
            message.To.Add(new MailboxAddress(toName, toAddress));
            message.Subject = subject;

            if (!string.IsNullOrEmpty(inReplyTo))
            {
                message.InReplyTo = inReplyTo;
            }

            message.Body = new TextPart("plain")
            {
                Text = body
            };

            using var client = new SmtpClient();

            var secureSocketOptions = settings.SmtpUseSsl
                ? SecureSocketOptions.SslOnConnect
                : SecureSocketOptions.StartTlsWhenAvailable;

            await client.ConnectAsync(settings.SmtpHost, settings.SmtpPort, secureSocketOptions, ct);
            await client.AuthenticateAsync(settings.SmtpUsername, settings.SmtpPassword, ct);
            await client.SendAsync(message, ct);
            await client.DisconnectAsync(true, ct);

            _logger.LogInformation("Email sent to {ToAddress}", toAddress);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to send email to {ToAddress}", toAddress);
            return false;
        }
    }

    private async Task ProcessEmailAsync(MimeMessage message, ChannelSettings settings, CancellationToken ct)
    {
        var fromAddress = message.From.Mailboxes.FirstOrDefault()?.Address;
        var fromName = message.From.Mailboxes.FirstOrDefault()?.Name;
        var subject = message.Subject ?? "(无主题)";
        var textBody = message.TextBody ?? message.HtmlBody ?? "";

        _logger.LogInformation(
            "Processing email from {From}: {Subject}",
            fromAddress,
            subject);

        // 检查是否在接受的域名列表中
        if (settings.AcceptedDomains.Count > 0)
        {
            var toAddresses = message.To.Mailboxes.Select(m => m.Address).ToList();
            var accepted = toAddresses.Any(to =>
                settings.AcceptedDomains.Any(domain =>
                    to?.EndsWith($"@{domain}", StringComparison.OrdinalIgnoreCase) == true));

            if (!accepted)
            {
                _logger.LogDebug("Email not addressed to accepted domain, skipping");
                return;
            }
        }

        // 创建通道任务
        var task = new ChannelTask
        {
            ChannelType = "email",
            ChannelMessageId = message.MessageId,
            SenderIdentifier = fromAddress ?? "unknown",
            SenderDisplayName = fromName,
            OriginalSubject = subject,
            OriginalContent = textBody,
            Status = "pending",
            StatusHistory = new List<ChannelTaskStatusChange>
            {
                new()
                {
                    Status = "pending",
                    At = DateTime.UtcNow,
                    Note = "Email received"
                }
            },
            Metadata = new Dictionary<string, object>
            {
                ["messageId"] = message.MessageId ?? "",
                ["date"] = message.Date.ToString("O"),
            }
        };

        await _db.ChannelTasks.InsertOneAsync(task, cancellationToken: ct);

        _logger.LogInformation("Created channel task {TaskId} for email from {From}", task.Id, fromAddress);

        // 发送确认回复（如果启用）
        if (settings.AutoAcknowledge && !string.IsNullOrEmpty(fromAddress))
        {
            await SendReplyAsync(
                fromAddress,
                fromName ?? fromAddress,
                $"Re: {subject}",
                "您的请求已收到，正在处理中。我们会尽快回复您。",
                message.MessageId,
                ct);
        }
    }

    private async Task<ChannelSettings?> GetSettingsAsync(CancellationToken ct)
    {
        return await _db.ChannelSettings.Find(s => s.Id == "default").FirstOrDefaultAsync(ct);
    }

    private async Task UpdatePollStatusAsync(bool success, string? error, int emailCount, CancellationToken ct)
    {
        var update = MongoDB.Driver.Builders<ChannelSettings>.Update
            .Set(s => s.LastPollAt, DateTime.UtcNow)
            .Set(s => s.LastPollResult, success ? "success" : "failed")
            .Set(s => s.LastPollError, error)
            .Set(s => s.LastPollEmailCount, emailCount)
            .Set(s => s.UpdatedAt, DateTime.UtcNow);

        await _db.ChannelSettings.UpdateOneAsync(
            s => s.Id == "default",
            update,
            cancellationToken: ct);
    }
}
