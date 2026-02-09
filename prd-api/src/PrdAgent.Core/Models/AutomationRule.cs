using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 自动化规则：当事件触发时，执行一组动作
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
public class AutomationRule
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>规则名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>是否启用</summary>
    public bool Enabled { get; set; } = true;

    // ── 触发器 ──

    /// <summary>事件类型（如 open-platform.quota.warning），支持通配符 *</summary>
    public string EventType { get; set; } = string.Empty;

    // ── 动作链 ──

    /// <summary>动作列表（按顺序执行）</summary>
    public List<AutomationAction> Actions { get; set; } = new();

    // ── 内容模板 ──

    /// <summary>标题模板覆盖，null 则用事件原始标题</summary>
    public string? TitleTemplate { get; set; }

    /// <summary>内容模板覆盖，null 则用事件原始内容</summary>
    public string? ContentTemplate { get; set; }

    // ── 元数据 ──

    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>最后触发时间</summary>
    public DateTime? LastTriggeredAt { get; set; }

    /// <summary>累计触发次数</summary>
    public long TriggerCount { get; set; }
}

/// <summary>
/// 自动化动作定义
/// </summary>
public class AutomationAction
{
    /// <summary>动作类型：webhook / admin_notification</summary>
    public string Type { get; set; } = string.Empty;

    // ── Webhook 配置 ──

    public string? WebhookUrl { get; set; }
    public string? WebhookSecret { get; set; }

    // ── 站内信配置 ──

    /// <summary>通知目标用户 ID 列表（空列表 = 全局通知）</summary>
    public List<string>? NotifyUserIds { get; set; }

    /// <summary>通知级别：info / warning / error</summary>
    public string? NotifyLevel { get; set; }
}

/// <summary>
/// 事件载荷（由各模块 Publish 时提供）
/// </summary>
public class AutomationEventPayload
{
    /// <summary>事件类型</summary>
    public string EventType { get; set; } = string.Empty;

    /// <summary>标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>内容（支持 {{value}} 占位符）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>按顺序替换 content 中 {{value}} 的值</summary>
    public List<string>? Values { get; set; }

    /// <summary>附加变量（用于模板替换 {{key}}）</summary>
    public Dictionary<string, string>? Variables { get; set; }

    /// <summary>事件来源标识（如 appId）</summary>
    public string? SourceId { get; set; }
}

/// <summary>
/// 预定义事件类型注册表
/// </summary>
public static class AutomationEventTypes
{
    public static readonly IReadOnlyList<EventTypeDef> All = new List<EventTypeDef>
    {
        new("open-platform.quota.warning", "开放平台", "额度预警"),
        new("visual-agent.image-gen.completed", "视觉创作", "生图完成"),
        new("visual-agent.image-gen.failed", "视觉创作", "生图失败"),
        new("defect-agent.report.created", "缺陷管理", "缺陷报告创建"),
        new("literary-agent.illustration.completed", "文学创作", "配图生成完成"),
    };
}

public sealed record EventTypeDef(string EventType, string Category, string Label);
