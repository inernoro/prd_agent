using MailKit;
using MailKit.Net.Imap;
using MailKit.Net.Smtp;
using MailKit.Search;
using MailKit.Security;
using Microsoft.Extensions.Logging;
using MimeKit;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 邮件通道服务实现
/// 使用 MailKit 进行 IMAP/SMTP 操作，支持意图检测和智能处理
/// </summary>
public class EmailChannelService : IEmailChannelService
{
    private readonly MongoDbContext _db;
    private readonly IEmailIntentDetector _intentDetector;
    private readonly IEnumerable<IEmailHandler> _handlers;
    private readonly ILogger<EmailChannelService> _logger;

    public EmailChannelService(
        MongoDbContext db,
        IEmailIntentDetector intentDetector,
        IEnumerable<IEmailHandler> handlers,
        ILogger<EmailChannelService> logger)
    {
        _db = db;
        _intentDetector = intentDetector;
        _handlers = handlers;
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
        var toAddresses = message.To.Mailboxes.Select(m => m.Address ?? "").ToList();

        _logger.LogInformation(
            "Processing email from {From}: {Subject}",
            fromAddress,
            subject);

        // 检查是否在接受的域名列表中
        if (settings.AcceptedDomains.Count > 0)
        {
            var accepted = toAddresses.Any(to =>
                settings.AcceptedDomains.Any(domain =>
                    to?.EndsWith($"@{domain}", StringComparison.OrdinalIgnoreCase) == true));

            if (!accepted)
            {
                _logger.LogDebug("Email not addressed to accepted domain, skipping");
                return;
            }
        }

        // 1. 意图检测
        var intent = await _intentDetector.DetectAsync(toAddresses, subject, textBody, ct);
        _logger.LogInformation(
            "Detected intent: {Type} (confidence: {Confidence:P0})",
            intent.Type,
            intent.Confidence);

        // 2. 查找发件人的身份映射
        string? mappedUserId = null;
        if (!string.IsNullOrEmpty(fromAddress))
        {
            var mapping = await _db.ChannelIdentityMappings
                .Find(m => m.ChannelType == "email" && m.ChannelIdentifier == fromAddress.ToLowerInvariant())
                .FirstOrDefaultAsync(ct);
            mappedUserId = mapping?.UserId;
        }

        // 3. 创建通道任务
        var task = new ChannelTask
        {
            ChannelType = "email",
            ChannelMessageId = message.MessageId,
            SenderIdentifier = fromAddress ?? "unknown",
            SenderDisplayName = fromName,
            MappedUserId = mappedUserId,
            OriginalSubject = subject,
            OriginalContent = textBody,
            Intent = intent.Type.ToString().ToLowerInvariant(),
            Status = ChannelTaskStatus.Processing,
            StatusHistory = new List<ChannelTaskStatusChange>
            {
                new()
                {
                    Status = ChannelTaskStatus.Pending,
                    At = DateTime.UtcNow,
                    Note = "Email received"
                },
                new()
                {
                    Status = ChannelTaskStatus.Processing,
                    At = DateTime.UtcNow,
                    Note = $"Intent: {intent.Type} ({intent.Confidence:P0})"
                }
            },
            Metadata = new Dictionary<string, object>
            {
                ["messageId"] = message.MessageId ?? "",
                ["date"] = message.Date.ToString("O"),
                ["intentConfidence"] = intent.Confidence,
                ["intentReason"] = intent.Reason ?? ""
            }
        };

        await _db.ChannelTasks.InsertOneAsync(task, cancellationToken: ct);
        _logger.LogInformation("Created channel task {TaskId} for email from {From}", task.Id, fromAddress);

        // 4. 查找并执行对应处理器
        var handler = _handlers.FirstOrDefault(h => h.IntentType == intent.Type);
        EmailHandleResult? result = null;

        if (handler != null)
        {
            try
            {
                result = await handler.HandleAsync(
                    task.Id,
                    fromAddress ?? "unknown",
                    fromName,
                    subject,
                    textBody,
                    intent,
                    mappedUserId,
                    ct);

                // 更新任务状态
                var update = Builders<ChannelTask>.Update
                    .Set(t => t.Status, result.Success ? ChannelTaskStatus.Completed : ChannelTaskStatus.Failed)
                    .Set(t => t.UpdatedAt, DateTime.UtcNow)
                    .Set(t => t.CompletedAt, DateTime.UtcNow)
                    .Push(t => t.StatusHistory, new ChannelTaskStatusChange
                    {
                        Status = result.Success ? ChannelTaskStatus.Completed : ChannelTaskStatus.Failed,
                        At = DateTime.UtcNow,
                        Note = result.Message
                    });

                if (result.EntityId != null)
                {
                    update = update.Set(t => t.Result, new ChannelTaskResult
                    {
                        Type = intent.Type.ToString().ToLowerInvariant(),
                        TextContent = result.Message,
                        Data = result.Data
                    });
                }

                await _db.ChannelTasks.UpdateOneAsync(t => t.Id == task.Id, update, cancellationToken: ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Handler {Handler} failed for task {TaskId}", handler.GetType().Name, task.Id);
                result = EmailHandleResult.Fail("处理失败", ex.Message);

                await _db.ChannelTasks.UpdateOneAsync(
                    t => t.Id == task.Id,
                    Builders<ChannelTask>.Update
                        .Set(t => t.Status, ChannelTaskStatus.Failed)
                        .Set(t => t.Error, ex.Message)
                        .Set(t => t.UpdatedAt, DateTime.UtcNow)
                        .Push(t => t.StatusHistory, new ChannelTaskStatusChange
                        {
                            Status = ChannelTaskStatus.Failed,
                            At = DateTime.UtcNow,
                            Note = ex.Message
                        }),
                    cancellationToken: ct);
            }
        }
        else
        {
            // 无匹配处理器，标记为待人工处理
            _logger.LogWarning("No handler found for intent {Intent}, task {TaskId} pending manual review", intent.Type, task.Id);

            await _db.ChannelTasks.UpdateOneAsync(
                t => t.Id == task.Id,
                Builders<ChannelTask>.Update
                    .Set(t => t.Status, ChannelTaskStatus.Pending)
                    .Push(t => t.StatusHistory, new ChannelTaskStatusChange
                    {
                        Status = ChannelTaskStatus.Pending,
                        At = DateTime.UtcNow,
                        Note = $"No handler for intent: {intent.Type}"
                    }),
                cancellationToken: ct);

            result = EmailHandleResult.Ok(
                "您的邮件已收到，但我暂时无法自动处理此类请求。\n\n" +
                "支持的操作：\n" +
                "- 发送到 classify@... 或主题加 [分类] → 邮件分类\n" +
                "- 发送到 todo@... 或主题加 [待办] → 创建待办事项\n\n" +
                "您的邮件已记录，稍后会有人工处理。");
        }

        // 5. 发送回复（如果有处理结果）
        if (result != null && !string.IsNullOrEmpty(fromAddress))
        {
            var replyBody = result.Message;
            if (!string.IsNullOrEmpty(result.Details))
            {
                replyBody += $"\n\n---\n{result.Details}";
            }

            await SendReplyAsync(
                fromAddress,
                fromName ?? fromAddress,
                $"Re: {subject}",
                replyBody,
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
        var update = Builders<ChannelSettings>.Update
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
