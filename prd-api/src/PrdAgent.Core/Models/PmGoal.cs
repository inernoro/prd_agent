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

    /// <summary>范围：team（团队目标，全员可见）| personal（个人目标，仅本人可见）。子目标强制继承父目标 Scope</summary>
    public string Scope { get; set; } = PmGoalScope.Team;

    /// <summary>父目标 Id；null/空 表示顶层目标。一经创建不可改（从根杜绝循环引用）</summary>
    public string? ParentId { get; set; }

    /// <summary>层级深度，顶层=0，每深一层 +1（冗余，用于缩进展示与递归深度防护）</summary>
    public int Depth { get; set; }

    /// <summary>归属人 UserId（个人目标=本人；团队目标=创建人，仅作展示）</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>目标标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>详细描述</summary>
    public string? Description { get; set; }

    /// <summary>衡量指标 / 关键结果（自由文本，旧字段；结构化 KR 见 KeyResults）</summary>
    public string? Metric { get; set; }

    /// <summary>关键结果 KR（结构化、可量化）。有 KR 时目标进度优先由 KR 完成度汇总。</summary>
    public List<PmKeyResult> KeyResults { get; set; } = new();

    /// <summary>负责人 UserId（问责到人，可指派，与 OwnerId/可见性解耦）</summary>
    public string? LeadId { get; set; }

    /// <summary>负责人名称（冗余）</summary>
    public string? LeadName { get; set; }

    /// <summary>信心指数：high | medium | low（取自最近一次 check-in，冗余便于列表展示）</summary>
    public string? Confidence { get; set; }

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

    /// <summary>目标递归拆解的最大层级（顶层 Depth=0，故最深节点 Depth=MaxGoalDepth-1）</summary>
    public const int MaxGoalDepth = 5;
}

/// <summary>关键结果 KR —— 可量化的结果指标。binary 用 Current 0/100 表达；数值型按区间归一算完成度。</summary>
public class PmKeyResult
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = string.Empty;
    /// <summary>类型：percent | number | currency | binary</summary>
    public string Type { get; set; } = PmKeyResultType.Percent;
    public double StartValue { get; set; }
    public double TargetValue { get; set; } = 100;
    public double CurrentValue { get; set; }
    /// <summary>单位（number/currency 用，如「个」「万元」）</summary>
    public string? Unit { get; set; }

    /// <summary>完成度 0-100（binary：Current&gt;=Target?100:0；数值：区间归一并裁剪）。</summary>
    public int ComputeProgress()
    {
        if (Type == PmKeyResultType.Binary) return CurrentValue >= TargetValue && TargetValue > 0 ? 100 : (CurrentValue >= 1 ? 100 : 0);
        var span = TargetValue - StartValue;
        if (Math.Abs(span) < 1e-9) return CurrentValue >= TargetValue ? 100 : 0;
        var frac = (CurrentValue - StartValue) / span;
        return (int)Math.Round(Math.Clamp(frac, 0, 1) * 100);
    }
}

/// <summary>KR 类型</summary>
public static class PmKeyResultType
{
    public const string Percent = "percent";
    public const string Number = "number";
    public const string Currency = "currency";
    public const string Binary = "binary";

    public static bool IsValid(string? v) => v is Percent or Number or Currency or Binary;
}

/// <summary>目标信心指数</summary>
public static class PmGoalConfidence
{
    public const string High = "high";
    public const string Medium = "medium";
    public const string Low = "low";

    public static bool IsValid(string? v) => v is High or Medium or Low;
}

/// <summary>目标进展 check-in（更新/讨论时间线）—— 独立集合 pm_goal_checkins。</summary>
public class PmGoalCheckIn
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string GoalId { get; set; } = string.Empty;
    public string ProjectId { get; set; } = string.Empty;
    public string AuthorId { get; set; } = string.Empty;
    public string? AuthorName { get; set; }
    /// <summary>本次填报进度快照（可空）</summary>
    public int? Progress { get; set; }
    /// <summary>本次信心：high | medium | low（可空）</summary>
    public string? Confidence { get; set; }
    /// <summary>进展说明 / 讨论</summary>
    public string Note { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
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
