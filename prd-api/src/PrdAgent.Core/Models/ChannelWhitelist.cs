namespace PrdAgent.Core.Models;

/// <summary>
/// 通道白名单配置
/// </summary>
public class ChannelWhitelist
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 通道类型：email, sms, siri, webhook
    /// </summary>
    public string ChannelType { get; set; } = ChannelTypes.Email;

    /// <summary>
    /// 身份标识模式（支持通配符）
    /// 示例：*@company.com, +8613800138000, specific@email.com
    /// </summary>
    public string IdentifierPattern { get; set; } = string.Empty;

    /// <summary>
    /// 绑定的系统用户ID（可选，绑定后所有请求以该用户身份执行）
    /// </summary>
    public string? BoundUserId { get; set; }

    /// <summary>
    /// 绑定用户的显示名称（冗余，便于展示）
    /// </summary>
    public string? BoundUserName { get; set; }

    /// <summary>
    /// 允许的 Agent 列表（空=全部允许）
    /// </summary>
    public List<string> AllowedAgents { get; set; } = new();

    /// <summary>
    /// 允许的操作类型（空=全部允许）
    /// </summary>
    public List<string> AllowedOperations { get; set; } = new();

    /// <summary>
    /// 每日调用限额（0=不限制）
    /// </summary>
    public int DailyQuota { get; set; } = 100;

    /// <summary>
    /// 今日已使用次数
    /// </summary>
    public int TodayUsedCount { get; set; } = 0;

    /// <summary>
    /// 今日使用统计的日期（用于重置计数）
    /// </summary>
    public string? TodayDate { get; set; }

    /// <summary>
    /// 是否启用
    /// </summary>
    public bool IsActive { get; set; } = true;

    /// <summary>
    /// 优先级（数字越小优先级越高，用于匹配顺序）
    /// </summary>
    public int Priority { get; set; } = 100;

    /// <summary>
    /// 备注
    /// </summary>
    public string? Note { get; set; }

    /// <summary>
    /// 创建人 AdminId
    /// </summary>
    public string? CreatedBy { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 通道类型常量
/// </summary>
public static class ChannelTypes
{
    public const string Email = "email";
    public const string Sms = "sms";
    public const string Siri = "siri";
    public const string Webhook = "webhook";

    public static readonly string[] All = { Email, Sms, Siri, Webhook };

    /// <summary>
    /// 获取通道显示名称
    /// </summary>
    public static string GetDisplayName(string channelType) => channelType switch
    {
        Email => "邮件",
        Sms => "短信",
        Siri => "Siri",
        Webhook => "Webhook",
        _ => channelType
    };
}
