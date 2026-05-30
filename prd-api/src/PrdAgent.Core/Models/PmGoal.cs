namespace PrdAgent.Core.Models;

/// <summary>
/// 项目目标 / 计划 — 区分团队目标（全员可见）与个人目标（仅本人可见）。
/// 可见性隔离在后端强制：个人目标的读/写都校验 OwnerId == 当前用户。
/// </summary>
public class PmGoal
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属项目</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>范围：team（团队目标，全员可见）| personal（个人目标，仅本人可见）</summary>
    public string Scope { get; set; } = PmGoalScope.Team;

    /// <summary>归属人 UserId（个人目标=本人；团队目标=创建人，仅作展示）</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>目标标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>详细描述</summary>
    public string? Description { get; set; }

    /// <summary>衡量指标 / 关键结果</summary>
    public string? Metric { get; set; }

    /// <summary>周期（如「2026 Q2」「6 月」）</summary>
    public string? Period { get; set; }

    /// <summary>进度 0-100（manual 模式下为手填值；auto 模式下作为无关联里程碑时的兜底）</summary>
    public int Progress { get; set; }

    /// <summary>进度模式：auto(由关联里程碑滚动) | manual(手填)。新建默认 auto</summary>
    public string ProgressMode { get; set; } = PmGoalProgressMode.Auto;

    /// <summary>状态：on_track | at_risk | done | abandoned</summary>
    public string Status { get; set; } = PmGoalStatus.OnTrack;

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>创建人名称（冗余）</summary>
    public string? CreatedByName { get; set; }

    /// <summary>同组排序键</summary>
    public long OrderKey { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>目标进度模式</summary>
public static class PmGoalProgressMode
{
    public const string Auto = "auto";
    public const string Manual = "manual";

    public static bool IsValid(string? v) => v is Auto or Manual;
}

/// <summary>目标范围</summary>
public static class PmGoalScope
{
    public const string Team = "team";
    public const string Personal = "personal";

    public static bool IsValid(string? v) => v is Team or Personal;
}

/// <summary>目标状态</summary>
public static class PmGoalStatus
{
    public const string OnTrack = "on_track";
    public const string AtRisk = "at_risk";
    public const string Done = "done";
    public const string Abandoned = "abandoned";

    public static bool IsValid(string? v) => v is OnTrack or AtRisk or Done or Abandoned;
}
