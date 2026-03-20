using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 周报团队
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay, IsPrimary = true)]
public class ReportTeam
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>团队名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>上级团队 ID（null 表示顶级团队）</summary>
    public string? ParentTeamId { get; set; }

    /// <summary>团队负责人 UserId</summary>
    public string LeaderUserId { get; set; } = string.Empty;

    /// <summary>负责人名称（冗余，便于展示）</summary>
    public string? LeaderName { get; set; }

    /// <summary>团队描述</summary>
    public string? Description { get; set; }

    /// <summary>绑定的数据采集工作流 ID（v2.0，从系统模板 clone）</summary>
    public string? DataCollectionWorkflowId { get; set; }

    /// <summary>使用的预置工作流模板 key（如 "dev-team", "product-team", "minimal"）</summary>
    public string? WorkflowTemplateKey { get; set; }

    /// <summary>
    /// 周报可见性设置：
    /// - all_members: 团队成员可互相查看周报（默认）
    /// - leaders_only: 仅负责人和副负责人可查看成员周报
    /// </summary>
    public string ReportVisibility { get; set; } = ReportVisibilityMode.AllMembers;

    /// <summary>
    /// 每周自动提交时间（如 "friday-18:00"），null 表示不自动提交。
    /// 格式: "{dayOfWeek}-{HH:mm}" (UTC+8)
    /// </summary>
    public string? AutoSubmitSchedule { get; set; }

    /// <summary>团队自定义每日打点标签（如 ["需求评审", "代码复查"]）</summary>
    public List<string> CustomDailyLogTags { get; set; } = new();

    /// <summary>
    /// 团队周报 AI 汇总的自定义 Prompt（为空时使用系统默认 Prompt）
    /// </summary>
    public string? TeamSummaryPrompt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 周报可见性模式常量
/// </summary>
public static class ReportVisibilityMode
{
    /// <summary>团队成员可互相查看周报</summary>
    public const string AllMembers = "all_members";

    /// <summary>仅负责人和副负责人可查看成员周报</summary>
    public const string LeadersOnly = "leaders_only";

    public static readonly string[] All = { AllMembers, LeadersOnly };
}

/// <summary>
/// 周报团队成员
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class ReportTeamMember
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属团队 ID</summary>
    public string TeamId { get; set; } = string.Empty;

    /// <summary>用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>用户名称（冗余，便于展示）</summary>
    public string? UserName { get; set; }

    /// <summary>用户头像文件名（冗余）</summary>
    public string? AvatarFileName { get; set; }

    /// <summary>角色：member / leader / deputy</summary>
    public string Role { get; set; } = ReportTeamRole.Member;

    /// <summary>岗位名称</summary>
    public string? JobTitle { get; set; }

    /// <summary>
    /// 多平台身份映射（v2.0）
    /// key: 平台名 (github / tapd / yuque / gitlab)
    /// value: 该平台上的用户标识
    /// </summary>
    public Dictionary<string, string> IdentityMappings { get; set; } = new();

    /// <summary>加入时间</summary>
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 团队角色常量
/// </summary>
public static class ReportTeamRole
{
    public const string Member = "member";
    public const string Leader = "leader";
    public const string Deputy = "deputy";

    public static readonly string[] All = { Member, Leader, Deputy };
}
