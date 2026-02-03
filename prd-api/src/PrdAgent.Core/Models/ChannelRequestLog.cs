namespace PrdAgent.Core.Models;

/// <summary>
/// 通道请求日志
/// </summary>
public class ChannelRequestLog
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 通道类型：email, sms, siri, webhook
    /// </summary>
    public string ChannelType { get; set; } = ChannelTypes.Email;

    /// <summary>
    /// 关联的任务ID
    /// </summary>
    public string? TaskId { get; set; }

    /// <summary>
    /// 发送者标识
    /// </summary>
    public string SenderIdentifier { get; set; } = string.Empty;

    /// <summary>
    /// 映射到的系统用户ID
    /// </summary>
    public string? MappedUserId { get; set; }

    /// <summary>
    /// 匹配的白名单规则ID
    /// </summary>
    public string? WhitelistId { get; set; }

    /// <summary>
    /// 识别的意图
    /// </summary>
    public string? Intent { get; set; }

    /// <summary>
    /// 目标 Agent
    /// </summary>
    public string? TargetAgent { get; set; }

    /// <summary>
    /// 请求状态：accepted, rejected, completed, failed
    /// </summary>
    public string Status { get; set; } = "accepted";

    /// <summary>
    /// 拒绝原因（被拒绝时）
    /// </summary>
    public string? RejectReason { get; set; }

    /// <summary>
    /// 执行耗时（毫秒）
    /// </summary>
    public long? DurationMs { get; set; }

    /// <summary>
    /// Token 使用量
    /// </summary>
    public ChannelTokenUsage? TokensUsed { get; set; }

    /// <summary>
    /// 错误信息
    /// </summary>
    public string? Error { get; set; }

    /// <summary>
    /// 错误代码
    /// </summary>
    public string? ErrorCode { get; set; }

    /// <summary>
    /// 客户端 IP
    /// </summary>
    public string? ClientIp { get; set; }

    /// <summary>
    /// User-Agent
    /// </summary>
    public string? UserAgent { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? EndedAt { get; set; }
}

/// <summary>
/// Token 使用量
/// </summary>
public class ChannelTokenUsage
{
    public int Input { get; set; }
    public int Output { get; set; }
    public int Total => Input + Output;
}

/// <summary>
/// 通道请求日志状态常量
/// </summary>
public static class ChannelRequestLogStatus
{
    public const string Accepted = "accepted";
    public const string Rejected = "rejected";
    public const string Completed = "completed";
    public const string Failed = "failed";

    public static readonly string[] All = { Accepted, Rejected, Completed, Failed };
}

/// <summary>
/// 通道请求拒绝原因常量
/// </summary>
public static class ChannelRejectReason
{
    public const string NotWhitelisted = "not_whitelisted";
    public const string QuotaExceeded = "quota_exceeded";
    public const string AgentNotAllowed = "agent_not_allowed";
    public const string OperationNotAllowed = "operation_not_allowed";
    public const string InvalidSignature = "invalid_signature";
    public const string RateLimited = "rate_limited";
    public const string ContentBlocked = "content_blocked";

    public static string GetDisplayName(string reason) => reason switch
    {
        NotWhitelisted => "不在白名单中",
        QuotaExceeded => "超出每日配额",
        AgentNotAllowed => "Agent 未授权",
        OperationNotAllowed => "操作未授权",
        InvalidSignature => "签名验证失败",
        RateLimited => "请求频率过高",
        ContentBlocked => "内容安全拦截",
        _ => reason
    };
}
