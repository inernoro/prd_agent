namespace PrdAgent.Core.Models;

/// <summary>
/// 项目里程碑 — 独立节点对象（非"特殊任务"）。标识阶段性关键交付节点。
/// 任务通过 PmTask.MilestoneId 归属里程碑；进度由其下任务完成度读时滚动，不冗存。
/// </summary>
public class PmMilestone
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属项目（=计划容器）</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>里程碑名称</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>说明</summary>
    public string? Description { get; set; }

    /// <summary>预计达成时间</summary>
    public DateTime? DueAt { get; set; }

    /// <summary>实际达成时间（标记达成时落）</summary>
    public DateTime? ReachedAt { get; set; }

    /// <summary>关联目标（可空）</summary>
    public string? GoalId { get; set; }

    /// <summary>负责人 UserId（可空）—— 里程碑问责到人</summary>
    public string? OwnerId { get; set; }

    /// <summary>负责人名称（冗余，便于展示）</summary>
    public string? OwnerName { get; set; }

    /// <summary>验收标准 / 完成定义（DoD）。全部勾选才允许标记达成（二元签收）。</summary>
    public List<PmMilestoneCriterion> AcceptanceCriteria { get; set; } = new();

    /// <summary>状态：planned | reached | cancelled（存储真值；健康度 overdue/at_risk 由日期+进度派生）</summary>
    public string Status { get; set; } = PmMilestoneStatus.Planned;

    /// <summary>同项目内排序键</summary>
    public long OrderKey { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>里程碑验收标准条目（完成定义 DoD）</summary>
public class PmMilestoneCriterion
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Text { get; set; } = string.Empty;
    public bool Done { get; set; }
}

/// <summary>里程碑状态（存储真值）</summary>
public static class PmMilestoneStatus
{
    public const string Planned = "planned";
    public const string Reached = "reached";
    public const string Cancelled = "cancelled";

    public static bool IsValid(string? v) => v is Planned or Reached or Cancelled;
}
