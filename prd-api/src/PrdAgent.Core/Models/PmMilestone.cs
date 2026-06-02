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

    /// <summary>预计达成时间（当前计划日，可随重排变化）</summary>
    public DateTime? DueAt { get; set; }

    /// <summary>基线计划日（首次计划快照；用于对比当前计划的滑移/趋势）。重设基线时刷新。</summary>
    public DateTime? BaselineDueAt { get; set; }

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

    /// <summary>前置里程碑 Id 列表（本里程碑依赖它们先达成；保持 DAG，不可成环）。</summary>
    public List<string> DependsOn { get; set; } = new();

    /// <summary>交付物引用（被本里程碑验收/批准的产物：周报 / 决策 / 外链）。</summary>
    public List<PmDeliverableRef> Deliverables { get; set; } = new();

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

/// <summary>里程碑交付物引用（被验收的产物快照）</summary>
public class PmDeliverableRef
{
    /// <summary>类型：weekly(周报) | decision(决策) | link(外链)</summary>
    public string Type { get; set; } = "link";
    /// <summary>引用实体 Id（link 类型可空）</summary>
    public string? RefId { get; set; }
    /// <summary>标题快照（便于展示，避免被删后空白）</summary>
    public string Title { get; set; } = string.Empty;
    /// <summary>外链地址（type=link 时用）</summary>
    public string? Url { get; set; }
}

/// <summary>里程碑状态（存储真值）</summary>
public static class PmMilestoneStatus
{
    public const string Planned = "planned";
    public const string Reached = "reached";
    public const string Cancelled = "cancelled";

    public static bool IsValid(string? v) => v is Planned or Reached or Cancelled;
}
