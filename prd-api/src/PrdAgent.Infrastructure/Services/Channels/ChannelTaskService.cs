using Microsoft.Extensions.Logging;
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
        CancellationToken ct = default)
    {
        // 1. 识别意图
        var intentResult = _intentDetector.Detect(subject, content);

        // 2. 白名单验证
        var matchResult = await _whitelistMatcher.MatchAsync(
            channelType,
            senderIdentifier,
            intentResult.TargetAgent,
            intentResult.Intent,
            ct);

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

        if (string.IsNullOrWhiteSpace(mappedUserId))
        {
            var identityMapping = await _whitelistMatcher.ResolveIdentityAsync(channelType, senderIdentifier, ct);
            if (identityMapping != null)
            {
                mappedUserId = identityMapping.UserId;
                mappedUserName = identityMapping.UserName;
            }
        }

        // 4. 创建任务
        var task = new ChannelTask
        {
            Id = GenerateTaskId(),
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

        await _db.ChannelTasks.InsertOneAsync(task, cancellationToken: ct);

        _logger.LogInformation("Channel task created: {TaskId} from {Sender} intent={Intent} agent={Agent}",
            task.Id, senderIdentifier, task.Intent, task.TargetAgent);

        // 5. 记录请求日志
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
        string? whitelistId = null)
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

        await _db.ChannelRequestLogs.InsertOneAsync(log, cancellationToken: ct);
    }

    private static string GenerateTaskId()
    {
        var date = DateTime.UtcNow.ToString("yyyyMMdd");
        var seq = Guid.NewGuid().ToString("N")[..6].ToUpper();
        return $"TASK-{date}-{seq}";
    }
}
