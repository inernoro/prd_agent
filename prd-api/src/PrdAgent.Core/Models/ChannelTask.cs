namespace PrdAgent.Core.Models;

/// <summary>
/// 通道任务
/// </summary>
public class ChannelTask
{
    /// <summary>主键（格式：TASK-yyyyMMdd-序号）</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>
    /// 通道类型：email, sms, siri, webhook
    /// </summary>
    public string ChannelType { get; set; } = ChannelTypes.Email;

    /// <summary>
    /// 通道消息ID（如邮件的 Message-ID）
    /// </summary>
    public string? ChannelMessageId { get; set; }

    /// <summary>
    /// 发送者标识（邮箱、手机号等）
    /// </summary>
    public string SenderIdentifier { get; set; } = string.Empty;

    /// <summary>
    /// 发送者显示名称
    /// </summary>
    public string? SenderDisplayName { get; set; }

    /// <summary>
    /// 映射到的系统用户ID（通过白名单绑定或身份映射解析）
    /// </summary>
    public string? MappedUserId { get; set; }

    /// <summary>
    /// 映射用户显示名称
    /// </summary>
    public string? MappedUserName { get; set; }

    /// <summary>
    /// 匹配的白名单规则ID
    /// </summary>
    public string? WhitelistId { get; set; }

    /// <summary>
    /// 识别的意图
    /// </summary>
    public string? Intent { get; set; }

    /// <summary>
    /// 目标 Agent（如 visual-agent, prd-agent）
    /// </summary>
    public string? TargetAgent { get; set; }

    /// <summary>
    /// 原始内容（邮件主题+正文、短信内容等）
    /// </summary>
    public string OriginalContent { get; set; } = string.Empty;

    /// <summary>
    /// 原始主题（邮件场景）
    /// </summary>
    public string? OriginalSubject { get; set; }

    /// <summary>
    /// 解析后的参数
    /// </summary>
    public Dictionary<string, object> ParsedParameters { get; set; } = new();

    /// <summary>
    /// 附件信息
    /// </summary>
    public List<ChannelTaskAttachment> Attachments { get; set; } = new();

    /// <summary>
    /// 任务状态：pending, processing, completed, failed, cancelled
    /// </summary>
    public string Status { get; set; } = ChannelTaskStatus.Pending;

    /// <summary>
    /// 状态历史
    /// </summary>
    public List<ChannelTaskStatusChange> StatusHistory { get; set; } = new();

    /// <summary>
    /// 执行结果
    /// </summary>
    public ChannelTaskResult? Result { get; set; }

    /// <summary>
    /// 错误信息（失败时）
    /// </summary>
    public string? Error { get; set; }

    /// <summary>
    /// 错误代码
    /// </summary>
    public string? ErrorCode { get; set; }

    /// <summary>
    /// 已发送的响应列表
    /// </summary>
    public List<ChannelTaskResponse> ResponsesSent { get; set; } = new();

    /// <summary>
    /// 重试次数
    /// </summary>
    public int RetryCount { get; set; } = 0;

    /// <summary>
    /// 最大重试次数
    /// </summary>
    public int MaxRetries { get; set; } = 3;

    /// <summary>
    /// 父任务ID（重试时指向原任务）
    /// </summary>
    public string? ParentTaskId { get; set; }

    /// <summary>
    /// 原始消息元数据
    /// </summary>
    public Dictionary<string, object> Metadata { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? StartedAt { get; set; }

    public DateTime? CompletedAt { get; set; }

    /// <summary>
    /// 执行耗时（毫秒）
    /// </summary>
    public long? DurationMs { get; set; }
}

/// <summary>
/// 通道任务附件
/// </summary>
public class ChannelTaskAttachment
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string FileName { get; set; } = string.Empty;
    public long FileSize { get; set; }
    public string MimeType { get; set; } = string.Empty;
    public string? Url { get; set; }
    public DateTime UploadedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 通道任务状态变更记录
/// </summary>
public class ChannelTaskStatusChange
{
    public string Status { get; set; } = string.Empty;
    public DateTime At { get; set; } = DateTime.UtcNow;
    public string? Note { get; set; }
}

/// <summary>
/// 通道任务执行结果
/// </summary>
public class ChannelTaskResult
{
    /// <summary>
    /// 结果类型：text, image, list, error
    /// </summary>
    public string Type { get; set; } = "text";

    /// <summary>
    /// 文本内容
    /// </summary>
    public string? TextContent { get; set; }

    /// <summary>
    /// 图片URL（图像生成结果）
    /// </summary>
    public string? ImageUrl { get; set; }

    /// <summary>
    /// 图片列表（多图结果）
    /// </summary>
    public List<string>? ImageUrls { get; set; }

    /// <summary>
    /// 额外数据
    /// </summary>
    public Dictionary<string, object>? Data { get; set; }
}

/// <summary>
/// 通道任务响应记录
/// </summary>
public class ChannelTaskResponse
{
    /// <summary>
    /// 响应类型：task-received, task-completed, task-failed
    /// </summary>
    public string Type { get; set; } = string.Empty;

    /// <summary>
    /// 发送时间
    /// </summary>
    public DateTime SentAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 响应消息ID（如邮件的 Message-ID）
    /// </summary>
    public string? MessageId { get; set; }

    /// <summary>
    /// 发送状态：pending, sent, failed
    /// </summary>
    public string Status { get; set; } = "sent";

    /// <summary>
    /// 错误信息
    /// </summary>
    public string? Error { get; set; }
}

/// <summary>
/// 通道任务状态常量
/// </summary>
public static class ChannelTaskStatus
{
    public const string Pending = "pending";
    public const string Processing = "processing";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";

    public static readonly string[] All = { Pending, Processing, Completed, Failed, Cancelled };

    public static string GetDisplayName(string status) => status switch
    {
        Pending => "待处理",
        Processing => "处理中",
        Completed => "已完成",
        Failed => "失败",
        Cancelled => "已取消",
        _ => status
    };
}

/// <summary>
/// 通道任务意图常量
/// </summary>
public static class ChannelTaskIntent
{
    public const string ImageGen = "image-gen";
    public const string DefectCreate = "defect-create";
    public const string DefectQuery = "defect-query";
    public const string PrdQuery = "prd-query";
    public const string Help = "help";
    public const string Cancel = "cancel";
    public const string Unknown = "unknown";

    public static readonly string[] All = { ImageGen, DefectCreate, DefectQuery, PrdQuery, Help, Cancel, Unknown };
}

/// <summary>
/// 通道任务响应类型常量
/// </summary>
public static class ChannelTaskResponseType
{
    public const string TaskReceived = "task-received";
    public const string TaskCompleted = "task-completed";
    public const string TaskFailed = "task-failed";
}
