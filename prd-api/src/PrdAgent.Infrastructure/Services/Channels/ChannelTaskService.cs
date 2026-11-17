using Microsoft.Extensions.Logging;
using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Channels;

/// <summary>
/// 通道任务管理服务
/// </summary>
public class ChannelTaskService
{
    private readonly MongoDbContext _db;
    private readonly WhitelistMatcherService _whitelistMatcher;
    private readonly IntentDetectorService _intentDetector;
    private readonly ILogger<ChannelTaskService> _logger;

    public ChannelTaskService(
        MongoDbContext db,
        WhitelistMatcherService whitelistMatcher,
        IntentDetectorService intentDetector,
        ILogger<ChannelTaskService> logger)
    {
        _db = db;
        _whitelistMatcher = whitelistMatcher;
        _intentDetector = intentDetector;
        _logger = logger;
    }

    /// <summary>
    /// 创建任务结果
    /// </summary>
    public class CreateTaskResult
    {
        public bool Success { get; set; }
        public ChannelTask? Task { get; set; }
        public string? RejectReason { get; set; }
        public string? RejectReasonDisplay { get; set; }

        public static CreateTaskResult Ok(ChannelTask task) => new() { Success = true, Task = task };
        public static CreateTaskResult Fail(string reason, string display) => new()
        {
            Success = false,
            RejectReason = reason,
            RejectReasonDisplay = display
        };
    }

    /// <summary>
    /// 创建通道任务
    /// </summary>
    /// <param name="channelType">通道类型</param>
    /// <param name="senderIdentifier">发送者标识</param>
    /// <param name="senderDisplayName">发送者显示名称</param>
    /// <param name="subject">主题（邮件场景）</param>
    /// <param name="content">内容</param>
    /// <param name="messageId">通道消息ID</param>
    /// <param name="attachments">附件</param>
    /// <param name="metadata">元数据</param>
    /// <param name="ct">取消令牌</param>
    public async Task<CreateTaskResult> CreateTaskAsync(
        string channelType,
        string senderIdentifier,
        string? senderDisplayName,
        string? subject,
        string content,
        string? messageId = null,
        List<ChannelTaskAttachment>? attachments = null,
        Dictionary<string, object>? metadata = null,
        CancellationToken ct = default,
        VerifiedEmailIngress? trustedEmailIngress = null)
    {
        string? ingressTaskId = null;
        User? ingressOwner = null;
        if (trustedEmailIngress != null)
        {
            if (channelType != ChannelTypes.Email || string.IsNullOrWhiteSpace(trustedEmailIngress.Recipient)
                || string.IsNullOrWhiteSpace(trustedEmailIngress.DeliveryKey))
                return CreateTaskResult.Fail("INVALID_INGRESS", "邮件通道配置无效");
            ingressOwner = await _db.Users.Find(x => x.UserId == trustedEmailIngress.OwnerUserId
                && x.Status == UserStatus.Active).FirstOrDefaultAsync(ct);
            if (ingressOwner == null)
                return CreateTaskResult.Fail("INVALID_OWNER", "邮件通道归属用户不可用");
            // Mongo's built-in unique _id provides atomic deduplication across processes/restarts.
            // Exclude signature and timestamp: provider retries may re-sign the same message.
            var identity = "sendgrid-inbound-parse\n" + trustedEmailIngress.Recipient.ToLowerInvariant()
                + "\n" + trustedEmailIngress.DeliveryKey;
            ingressTaskId = "EMAIL-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
            var existing = await _db.ChannelTasks.Find(x => x.Id == ingressTaskId).FirstOrDefaultAsync(ct);
            if (existing != null)
            {
                await EnsureEmailAcceptedLogAsync(existing, ct);
                return CreateTaskResult.Ok(existing);
            }
        }

        // 1. 识别意图
        var intentResult = _intentDetector.Detect(subject, content);

        // 2. 白名单验证
        var matchResult = await _whitelistMatcher.MatchAsync(
            channelType,
            senderIdentifier,
            intentResult.TargetAgent,
            intentResult.Intent,
            ct,
            ingressTaskId);

        if (!matchResult.IsMatch)
        {
            _logger.LogInformation("Task creation rejected for {Sender}: {Reason}",
                senderIdentifier, matchResult.RejectReason);

            // 记录拒绝日志
            await LogRequestAsync(channelType, senderIdentifier, null, null,
                ChannelRequestLogStatus.Rejected, matchResult.RejectReason, ct);

            return CreateTaskResult.Fail(matchResult.RejectReason!, matchResult.RejectReasonDisplay!);
        }

        // 3. 解析身份映射
        string? mappedUserId = matchResult.Whitelist!.BoundUserId;
        string? mappedUserName = matchResult.Whitelist.BoundUserName;

        if (ingressOwner == null && string.IsNullOrWhiteSpace(mappedUserId))
        {
            var identityMapping = await _whitelistMatcher.ResolveIdentityAsync(channelType, senderIdentifier, ct);
            if (identityMapping != null)
            {
                mappedUserId = identityMapping.UserId;
                mappedUserName = identityMapping.UserName;
            }
        }

        if (ingressOwner != null)
        {
            mappedUserId = ingressOwner.UserId;
            mappedUserName = ingressOwner.DisplayName;
        }

        // 4. 创建任务
        var task = new ChannelTask
        {
            Id = ingressTaskId ?? GenerateTaskId(),
            ChannelType = channelType,
            ChannelMessageId = messageId,
            SenderIdentifier = senderIdentifier.ToLowerInvariant(),
            SenderDisplayName = senderDisplayName,
            MappedUserId = mappedUserId,
            MappedUserName = mappedUserName,
            WhitelistId = matchResult.Whitelist.Id,
            Intent = intentResult.Intent,
            TargetAgent = intentResult.TargetAgent,
            OriginalContent = intentResult.CleanContent,
            OriginalSubject = subject,
            ParsedParameters = intentResult.Parameters,
            Attachments = attachments ?? new List<ChannelTaskAttachment>(),
            Status = ChannelTaskStatus.Pending,
            Metadata = metadata ?? new Dictionary<string, object>()
        };

        task.StatusHistory.Add(new ChannelTaskStatusChange
        {
            Status = ChannelTaskStatus.Pending,
            At = DateTime.UtcNow
        });

        try
        {
            await _db.ChannelTasks.InsertOneAsync(task, cancellationToken: ct);
        }
        catch (MongoWriteException ex) when (ingressTaskId != null
            && ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            var existing = await _db.ChannelTasks.Find(x => x.Id == ingressTaskId).FirstOrDefaultAsync(ct);
            if (existing == null) throw;
            await EnsureEmailAcceptedLogAsync(existing, ct);
            return CreateTaskResult.Ok(existing);
        }

        _logger.LogInformation("Channel task created: {TaskId} from {Sender} intent={Intent} agent={Agent}",
            task.Id, senderIdentifier, task.Intent, task.TargetAgent);

        // 5. 记录请求日志
        if (ingressTaskId != null)
            await EnsureEmailAcceptedLogAsync(task, ct);
        else
            await LogRequestAsync(channelType, senderIdentifier, mappedUserId, task.Id,
                ChannelRequestLogStatus.Accepted, null, ct,
                intentResult.Intent, intentResult.TargetAgent, matchResult.Whitelist.Id);

        return CreateTaskResult.Ok(task);
    }

    /// <summary>
    /// 更新任务状态
    /// </summary>
    public async Task<bool> UpdateTaskStatusAsync(
        string taskId,
        string newStatus,
        string? note = null,
        ChannelTaskResult? result = null,
        string? error = null,
        string? errorCode = null,
        CancellationToken ct = default)
    {
        var updateBuilder = Builders<ChannelTask>.Update;
        var updates = new List<UpdateDefinition<ChannelTask>>
        {
            updateBuilder.Set(x => x.Status, newStatus),
            updateBuilder.Set(x => x.UpdatedAt, DateTime.UtcNow),
            updateBuilder.Push(x => x.StatusHistory, new ChannelTaskStatusChange
            {
                Status = newStatus,
                At = DateTime.UtcNow,
                Note = note
            })
        };

        if (newStatus == ChannelTaskStatus.Processing)
        {
            updates.Add(updateBuilder.Set(x => x.StartedAt, DateTime.UtcNow));
        }

        if (newStatus is ChannelTaskStatus.Completed or ChannelTaskStatus.Failed or ChannelTaskStatus.Cancelled)
        {
            updates.Add(updateBuilder.Set(x => x.CompletedAt, DateTime.UtcNow));

            // 计算耗时
            var task = await _db.ChannelTasks.Find(x => x.Id == taskId).FirstOrDefaultAsync(ct);
            if (task?.StartedAt != null)
            {
                var duration = (long)(DateTime.UtcNow - task.StartedAt.Value).TotalMilliseconds;
                updates.Add(updateBuilder.Set(x => x.DurationMs, duration));
            }
        }

        if (result != null)
        {
            updates.Add(updateBuilder.Set(x => x.Result, result));
        }

        if (error != null)
        {
            updates.Add(updateBuilder.Set(x => x.Error, error));
        }

        if (errorCode != null)
        {
            updates.Add(updateBuilder.Set(x => x.ErrorCode, errorCode));
        }

        var updateResult = await _db.ChannelTasks.UpdateOneAsync(
            x => x.Id == taskId,
            updateBuilder.Combine(updates),
            cancellationToken: ct);

        return updateResult.ModifiedCount > 0;
    }

    /// <summary>
    /// 记录任务响应
    /// </summary>
    public async Task AddTaskResponseAsync(
        string taskId,
        string responseType,
        string? responseMessageId = null,
        string? error = null,
        CancellationToken ct = default)
    {
        var response = new ChannelTaskResponse
        {
            Type = responseType,
            SentAt = DateTime.UtcNow,
            MessageId = responseMessageId,
            Status = string.IsNullOrWhiteSpace(error) ? "sent" : "failed",
            Error = error
        };

        var update = Builders<ChannelTask>.Update
            .Push(x => x.ResponsesSent, response)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.ChannelTasks.UpdateOneAsync(x => x.Id == taskId, update, cancellationToken: ct);
    }

    /// <summary>
    /// 获取待处理的任务
    /// </summary>
    public async Task<List<ChannelTask>> GetPendingTasksAsync(
        string? channelType = null,
        int limit = 100,
        CancellationToken ct = default)
    {
        var filterBuilder = Builders<ChannelTask>.Filter;
        var filter = filterBuilder.Eq(x => x.Status, ChannelTaskStatus.Pending);

        if (!string.IsNullOrWhiteSpace(channelType))
        {
            filter = filterBuilder.And(filter, filterBuilder.Eq(x => x.ChannelType, channelType));
        }

        return await _db.ChannelTasks
            .Find(filter)
            .SortBy(x => x.CreatedAt)
            .Limit(limit)
            .ToListAsync(ct);
    }

    private async Task EnsureEmailAcceptedLogAsync(ChannelTask task, CancellationToken ct)
    {
        // Preserve an existing acceptance record, including the previous version's random ID.
        if (await _db.ChannelRequestLogs.Find(x => x.TaskId == task.Id
            && x.Status == ChannelRequestLogStatus.Accepted).AnyAsync(ct)) return;
        await LogRequestAsync(task.ChannelType, task.SenderIdentifier, task.MappedUserId, task.Id,
            ChannelRequestLogStatus.Accepted, null, ct, task.Intent, task.TargetAgent,
            task.WhitelistId, "EMAIL-ACCEPTED-" + task.Id);
    }

    /// <summary>
    /// 记录请求日志
    /// </summary>
    private async Task LogRequestAsync(
        string channelType,
        string senderIdentifier,
        string? mappedUserId,
        string? taskId,
        string status,
        string? rejectReason,
        CancellationToken ct,
        string? intent = null,
        string? targetAgent = null,
        string? whitelistId = null,
        string? idempotentLogId = null)
    {
        var log = new ChannelRequestLog
        {
            ChannelType = channelType,
            TaskId = taskId,
            SenderIdentifier = senderIdentifier.ToLowerInvariant(),
            MappedUserId = mappedUserId,
            WhitelistId = whitelistId,
            Intent = intent,
            TargetAgent = targetAgent,
            Status = status,
            RejectReason = rejectReason
        };

        if (idempotentLogId != null) log.Id = idempotentLogId;
        try
        {
            await _db.ChannelRequestLogs.InsertOneAsync(log, cancellationToken: ct);
        }
        catch (MongoWriteException ex) when (idempotentLogId != null
            && ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            // A concurrent request already repaired the same task's acceptance record.
        }
    }

    private static string GenerateTaskId()
    {
        var date = DateTime.UtcNow.ToString("yyyyMMdd");
        var seq = Guid.NewGuid().ToString("N")[..6].ToUpper();
        return $"TASK-{date}-{seq}";
    }
}
