namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 创建/更新白名单请求
/// </summary>
public class UpsertChannelWhitelistRequest
{
    /// <summary>通道类型：email, sms, siri, webhook</summary>
    public string ChannelType { get; set; } = "email";

    /// <summary>身份模式（支持通配符 *）</summary>
    public string IdentifierPattern { get; set; } = string.Empty;

    /// <summary>绑定的系统用户ID（可选）</summary>
    public string? BoundUserId { get; set; }

    /// <summary>允许的 Agent 列表（空=全部）</summary>
    public List<string>? AllowedAgents { get; set; }

    /// <summary>允许的操作类型（空=全部）</summary>
    public List<string>? AllowedOperations { get; set; }

    /// <summary>每日限额（0=不限制）</summary>
    public int DailyQuota { get; set; } = 100;

    /// <summary>优先级（越小越高）</summary>
    public int Priority { get; set; } = 100;

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>备注</summary>
    public string? Note { get; set; }
}

/// <summary>
/// 创建/更新身份映射请求
/// </summary>
public class UpsertChannelIdentityMappingRequest
{
    /// <summary>通道类型</summary>
    public string ChannelType { get; set; } = "email";

    /// <summary>通道内唯一标识（邮箱、手机号等）</summary>
    public string ChannelIdentifier { get; set; } = string.Empty;

    /// <summary>映射到的系统用户ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>是否已验证</summary>
    public bool IsVerified { get; set; } = true;
}

/// <summary>
/// 白名单列表查询参数
/// </summary>
public class ChannelWhitelistQueryParams
{
    public string? ChannelType { get; set; }
    public bool? IsActive { get; set; }
    public string? Search { get; set; }
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 20;
}

/// <summary>
/// 身份映射列表查询参数
/// </summary>
public class ChannelIdentityMappingQueryParams
{
    public string? ChannelType { get; set; }
    public string? UserId { get; set; }
    public bool? IsVerified { get; set; }
    public string? Search { get; set; }
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 20;
}

/// <summary>
/// 任务列表查询参数
/// </summary>
public class ChannelTaskQueryParams
{
    public string? ChannelType { get; set; }
    public string? Status { get; set; }
    public string? TargetAgent { get; set; }
    public string? SenderIdentifier { get; set; }
    public string? MappedUserId { get; set; }
    public DateTime? StartDate { get; set; }
    public DateTime? EndDate { get; set; }
    public string? Search { get; set; }
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 20;
}

/// <summary>
/// 通道统计响应
/// </summary>
public class ChannelStatsResponse
{
    /// <summary>各通道状态</summary>
    public List<ChannelStatusInfo> Channels { get; set; } = new();

    /// <summary>今日任务总数</summary>
    public int TodayTaskCount { get; set; }

    /// <summary>今日处理中任务数</summary>
    public int ProcessingCount { get; set; }

    /// <summary>今日成功率</summary>
    public double SuccessRate { get; set; }

    /// <summary>今日平均耗时（秒）</summary>
    public double AvgDurationSeconds { get; set; }

    /// <summary>白名单总数</summary>
    public int WhitelistCount { get; set; }

    /// <summary>身份映射总数</summary>
    public int IdentityMappingCount { get; set; }
}

/// <summary>
/// 单个通道状态信息
/// </summary>
public class ChannelStatusInfo
{
    /// <summary>通道类型</summary>
    public string ChannelType { get; set; } = string.Empty;

    /// <summary>通道显示名称</summary>
    public string DisplayName { get; set; } = string.Empty;

    /// <summary>是否已配置/启用</summary>
    public bool IsEnabled { get; set; }

    /// <summary>今日请求数</summary>
    public int TodayRequestCount { get; set; }

    /// <summary>今日成功数</summary>
    public int TodaySuccessCount { get; set; }

    /// <summary>今日失败数</summary>
    public int TodayFailCount { get; set; }
}

/// <summary>
/// 分页响应包装
/// </summary>
public class PagedResponse<T>
{
    public List<T> Items { get; set; } = new();
    public int Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
    public int TotalPages => (int)Math.Ceiling((double)Total / PageSize);
}

/// <summary>
/// 更新邮箱配置请求
/// </summary>
public class UpdateChannelSettingsRequest
{
    // IMAP 收信配置
    public string? ImapHost { get; set; }
    public int? ImapPort { get; set; }
    public string? ImapUsername { get; set; }
    public string? ImapPassword { get; set; }
    public bool? ImapUseSsl { get; set; }
    public string? ImapFolder { get; set; }

    // SMTP 发信配置
    public string? SmtpHost { get; set; }
    public int? SmtpPort { get; set; }
    public string? SmtpUsername { get; set; }
    public string? SmtpPassword { get; set; }
    public bool? SmtpUseSsl { get; set; }
    public string? SmtpFromName { get; set; }
    public string? SmtpFromAddress { get; set; }

    // 轮询配置
    public int? PollIntervalMinutes { get; set; }
    public bool? IsEnabled { get; set; }

    // 高级配置
    public List<string>? AcceptedDomains { get; set; }
    public bool? AutoAcknowledge { get; set; }
    public bool? MarkAsReadAfterProcess { get; set; }
    public string? ProcessedFolder { get; set; }
}

/// <summary>
/// 测试 IMAP 连接请求
/// </summary>
public class TestConnectionRequest
{
    public string ImapHost { get; set; } = string.Empty;
    public int ImapPort { get; set; } = 993;
    public string ImapUsername { get; set; } = string.Empty;
    public string ImapPassword { get; set; } = string.Empty;
    public bool ImapUseSsl { get; set; } = true;
}

/// <summary>
/// 创建/更新工作流邮箱请求
/// </summary>
public class UpsertEmailWorkflowRequest
{
    /// <summary>邮箱前缀（如 todo、classify）</summary>
    public string? AddressPrefix { get; set; }

    /// <summary>显示名称</summary>
    public string? DisplayName { get; set; }

    /// <summary>描述说明</summary>
    public string? Description { get; set; }

    /// <summary>图标（emoji）</summary>
    public string? Icon { get; set; }

    /// <summary>意图类型（Classify, CreateTodo, Summarize, FollowUp）</summary>
    public string? IntentType { get; set; }

    /// <summary>目标 Agent</summary>
    public string? TargetAgent { get; set; }

    /// <summary>自定义处理提示词</summary>
    public string? CustomPrompt { get; set; }

    /// <summary>自动回复模板</summary>
    public string? ReplyTemplate { get; set; }

    /// <summary>是否启用</summary>
    public bool? IsActive { get; set; }

    /// <summary>优先级</summary>
    public int? Priority { get; set; }
}
