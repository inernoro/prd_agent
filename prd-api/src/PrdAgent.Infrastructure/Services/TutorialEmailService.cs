using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Extensions.Logging;
using MimeKit;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 教程邮件服务：序列引擎 + 模板渲染 + 邮件发送
/// </summary>
public interface ITutorialEmailService
{
    /// <summary>处理到期的 enrollment 记录，发送对应邮件</summary>
    Task<int> ProcessDueEnrollmentsAsync(CancellationToken ct);

    /// <summary>为用户注册一个邮件序列</summary>
    Task<TutorialEmailEnrollment?> EnrollUserAsync(string userId, string email, string sequenceKey, CancellationToken ct);

    /// <summary>发送单封教程邮件</summary>
    Task<bool> SendEmailAsync(string toEmail, string toName, string subject, string htmlBody, CancellationToken ct);
}

public class TutorialEmailService : ITutorialEmailService
{
    private readonly MongoDbContext _db;
    private readonly ILogger<TutorialEmailService> _logger;

    public TutorialEmailService(MongoDbContext db, ILogger<TutorialEmailService> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<int> ProcessDueEnrollmentsAsync(CancellationToken ct)
    {
        var now = DateTime.UtcNow;

        // 查找所有 active 且 nextSendAt <= now 的 enrollment
        var filter = Builders<TutorialEmailEnrollment>.Filter.Eq(x => x.Status, "active")
                   & Builders<TutorialEmailEnrollment>.Filter.Lte(x => x.NextSendAt, now)
                   & Builders<TutorialEmailEnrollment>.Filter.Ne(x => x.NextSendAt, null);

        var dueEnrollments = await _db.TutorialEmailEnrollments
            .Find(filter)
            .Limit(50) // 每次最多处理 50 条，避免单次过长
            .ToListAsync(ct);

        if (dueEnrollments.Count == 0) return 0;

        var processed = 0;

        foreach (var enrollment in dueEnrollments)
        {
            try
            {
                await ProcessSingleEnrollmentAsync(enrollment, ct);
                processed++;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to process enrollment {EnrollmentId} for user {UserId}",
                    enrollment.Id, enrollment.UserId);
            }
        }

        return processed;
    }

    private async Task ProcessSingleEnrollmentAsync(TutorialEmailEnrollment enrollment, CancellationToken ct)
    {
        // 获取序列定义
        var sequence = await _db.TutorialEmailSequences
            .Find(x => x.SequenceKey == enrollment.SequenceKey && x.IsActive)
            .FirstOrDefaultAsync(ct);

        if (sequence == null)
        {
            _logger.LogWarning("Sequence {SequenceKey} not found or inactive, completing enrollment {Id}",
                enrollment.SequenceKey, enrollment.Id);
            await UpdateEnrollmentStatusAsync(enrollment.Id, "completed", ct);
            return;
        }

        var nextStepIndex = enrollment.CurrentStepIndex + 1;

        if (nextStepIndex >= sequence.Steps.Count)
        {
            // 所有步骤已完成
            await UpdateEnrollmentStatusAsync(enrollment.Id, "completed", ct);
            return;
        }

        var step = sequence.Steps[nextStepIndex];

        // 获取模板
        var template = await _db.TutorialEmailTemplates
            .Find(x => x.Id == step.TemplateId)
            .FirstOrDefaultAsync(ct);

        if (template == null)
        {
            _logger.LogWarning("Template {TemplateId} not found for step {StepIndex} in sequence {SequenceKey}",
                step.TemplateId, nextStepIndex, enrollment.SequenceKey);
            // 跳过这个步骤，推进到下一个
            await AdvanceEnrollmentAsync(enrollment, nextStepIndex, sequence, false, "模板不存在", ct);
            return;
        }

        // 获取用户信息用于模板渲染
        var user = await _db.Users.Find(x => x.UserId == enrollment.UserId).FirstOrDefaultAsync(ct);
        var userName = user?.DisplayName ?? user?.Username ?? "用户";

        // 渲染模板
        var htmlBody = RenderTemplate(template.HtmlContent, new Dictionary<string, string>
        {
            ["userName"] = userName,
            ["userEmail"] = enrollment.Email,
            ["productName"] = "PRD Agent",
            ["stepNumber"] = (nextStepIndex + 1).ToString(),
            ["totalSteps"] = sequence.Steps.Count.ToString(),
        });

        // 发送邮件（使用 CancellationToken.None，服务器权威性设计）
        var success = await SendEmailAsync(enrollment.Email, userName, step.Subject, htmlBody, CancellationToken.None);

        // 更新 enrollment 状态
        await AdvanceEnrollmentAsync(enrollment, nextStepIndex, sequence, success,
            success ? null : "邮件发送失败", ct);

        if (success)
        {
            _logger.LogInformation("Tutorial email sent: user={UserId} sequence={SequenceKey} step={Step}/{Total}",
                enrollment.UserId, enrollment.SequenceKey, nextStepIndex + 1, sequence.Steps.Count);
        }
    }

    private async Task AdvanceEnrollmentAsync(
        TutorialEmailEnrollment enrollment,
        int completedStepIndex,
        TutorialEmailSequence sequence,
        bool success,
        string? errorMessage,
        CancellationToken ct)
    {
        var sentRecord = new TutorialEmailSentRecord
        {
            StepIndex = completedStepIndex,
            SentAt = DateTime.UtcNow,
            Success = success,
            ErrorMessage = errorMessage
        };

        var isLastStep = completedStepIndex >= sequence.Steps.Count - 1;
        var newStatus = isLastStep ? "completed" : "active";

        // 计算下次发送时间
        DateTime? nextSendAt = null;
        if (!isLastStep)
        {
            var nextStep = sequence.Steps[completedStepIndex + 1];
            var currentStep = sequence.Steps[completedStepIndex];
            var daysDelta = nextStep.DayOffset - currentStep.DayOffset;
            if (daysDelta <= 0) daysDelta = 1; // 至少间隔 1 天
            nextSendAt = DateTime.UtcNow.AddDays(daysDelta);
        }

        var update = Builders<TutorialEmailEnrollment>.Update
            .Set(x => x.CurrentStepIndex, completedStepIndex)
            .Set(x => x.Status, newStatus)
            .Set(x => x.NextSendAt, nextSendAt)
            .Set(x => x.UpdatedAt, DateTime.UtcNow)
            .Push(x => x.SentHistory, sentRecord);

        await _db.TutorialEmailEnrollments.UpdateOneAsync(x => x.Id == enrollment.Id, update, cancellationToken: ct);
    }

    private async Task UpdateEnrollmentStatusAsync(string enrollmentId, string status, CancellationToken ct)
    {
        var update = Builders<TutorialEmailEnrollment>.Update
            .Set(x => x.Status, status)
            .Set(x => x.NextSendAt, null)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.TutorialEmailEnrollments.UpdateOneAsync(x => x.Id == enrollmentId, update, cancellationToken: ct);
    }

    public async Task<TutorialEmailEnrollment?> EnrollUserAsync(string userId, string email, string sequenceKey, CancellationToken ct)
    {
        // 检查序列是否存在且启用
        var sequence = await _db.TutorialEmailSequences
            .Find(x => x.SequenceKey == sequenceKey && x.IsActive)
            .FirstOrDefaultAsync(ct);

        if (sequence == null || sequence.Steps.Count == 0)
        {
            _logger.LogWarning("Cannot enroll user {UserId}: sequence {SequenceKey} not found or has no steps",
                userId, sequenceKey);
            return null;
        }

        // 检查是否已存在
        var existing = await _db.TutorialEmailEnrollments
            .Find(x => x.UserId == userId && x.SequenceKey == sequenceKey)
            .FirstOrDefaultAsync(ct);

        if (existing != null)
        {
            _logger.LogDebug("User {UserId} already enrolled in sequence {SequenceKey}", userId, sequenceKey);
            return existing;
        }

        // 计算首次发送时间
        var firstStep = sequence.Steps[0];
        var nextSendAt = DateTime.UtcNow.AddDays(firstStep.DayOffset);

        var enrollment = new TutorialEmailEnrollment
        {
            UserId = userId,
            Email = email,
            SequenceKey = sequenceKey,
            CurrentStepIndex = -1,
            Status = "active",
            NextSendAt = nextSendAt,
            EnrolledAt = DateTime.UtcNow,
        };

        await _db.TutorialEmailEnrollments.InsertOneAsync(enrollment, cancellationToken: ct);
        _logger.LogInformation("User {UserId} enrolled in tutorial email sequence {SequenceKey}", userId, sequenceKey);
        return enrollment;
    }

    public async Task<bool> SendEmailAsync(string toEmail, string toName, string subject, string htmlBody, CancellationToken ct)
    {
        // 复用已有的 ChannelSettings 中的 SMTP 配置
        var settings = await _db.ChannelSettings.Find(s => s.Id == "default").FirstOrDefaultAsync(ct);
        if (settings == null || string.IsNullOrWhiteSpace(settings.SmtpHost))
        {
            _logger.LogWarning("SMTP settings not configured, cannot send tutorial email");
            return false;
        }

        try
        {
            var message = new MimeMessage();
            message.From.Add(new MailboxAddress(
                settings.SmtpFromName ?? "PRD Agent",
                settings.SmtpFromAddress ?? settings.SmtpUsername));
            message.To.Add(new MailboxAddress(toName, toEmail));
            message.Subject = subject;

            // 使用 HTML body
            var bodyBuilder = new BodyBuilder { HtmlBody = htmlBody };
            message.Body = bodyBuilder.ToMessageBody();

            using var client = new SmtpClient();
            var secureSocketOptions = settings.SmtpUseSsl
                ? SecureSocketOptions.SslOnConnect
                : SecureSocketOptions.StartTlsWhenAvailable;

            await client.ConnectAsync(settings.SmtpHost, settings.SmtpPort, secureSocketOptions, ct);
            await client.AuthenticateAsync(settings.SmtpUsername, settings.SmtpPassword, ct);
            await client.SendAsync(message, ct);
            await client.DisconnectAsync(true, ct);

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to send tutorial email to {ToEmail}", toEmail);
            return false;
        }
    }

    /// <summary>
    /// 简单的模板变量替换：将 {{variableName}} 替换为实际值
    /// </summary>
    private static string RenderTemplate(string htmlContent, Dictionary<string, string> variables)
    {
        var result = htmlContent;
        foreach (var (key, value) in variables)
        {
            result = result.Replace($"{{{{{key}}}}}", value);
        }
        return result;
    }
}
