namespace PrdAgent.Core.Models;

/// <summary>
/// OKR 周期 —— 结构化的目标周期容器（如 2026 Q2，含起止）。目标通过 PmGoal.CycleId 归属周期。
/// 周期可关闭（closed）用于期末盘点归档；删除周期不删目标，仅清空其 CycleId。
/// </summary>
public class PmGoalCycle
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属项目</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>周期名称（如「2026 Q2」「6 月冲刺」）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>起始日（可空）</summary>
    public DateTime? StartAt { get; set; }

    /// <summary>结束日（可空）</summary>
    public DateTime? EndAt { get; set; }

    /// <summary>状态：active（进行中）| closed（已盘点/归档）</summary>
    public string Status { get; set; } = PmGoalCycleStatus.Active;

    public long OrderKey { get; set; }
    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>OKR 周期状态</summary>
public static class PmGoalCycleStatus
{
    public const string Active = "active";
    public const string Closed = "closed";

    public static bool IsValid(string? v) => v is Active or Closed;
}
