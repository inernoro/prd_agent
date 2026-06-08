namespace PrdAgent.Core.Models;

/// <summary>
/// 项目管理 - 任务实体（执行层 / 进度留痕）。
///
/// 支撑三视图：看板（按 Status 分列）/ 列表（按 Priority 分组）/ 甘特图（StartAt + DueDate + DependsOn）。
/// 可追溯：SourceRef 记录任务源自需求文档的哪一段（AI 拆解时回填），呼应"反向自洽"理念。
/// </summary>
public class PmTask
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属项目 ID</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>任务标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>任务描述</summary>
    public string? Description { get; set; }

    /// <summary>父任务 ID（子任务，null 为顶层任务）</summary>
    public string? ParentTaskId { get; set; }

    /// <summary>所属里程碑 ID（可空；时间阶段轴：用于阶段聚合与甘特菱形归属）</summary>
    public string? MilestoneId { get; set; }

    /// <summary>所属目标 ID（可空；成果轴：与 MilestoneId 正交，无里程碑的任务也可直接归属目标）</summary>
    public string? GoalId { get; set; }

    /// <summary>
    /// 状态：backlog(待规划) / todo(待办) / in_progress(进行中) / done(已完成) / cancelled(已取消)
    /// </summary>
    public string Status { get; set; } = PmTaskStatus.Backlog;

    /// <summary>优先级：urgent / high / medium / low / none</summary>
    public string Priority { get; set; } = PmTaskPriority.None;

    /// <summary>负责人 UserId</summary>
    public string? AssigneeId { get; set; }

    /// <summary>负责人名称（冗余）</summary>
    public string? AssigneeName { get; set; }

    /// <summary>预估工时（人天）</summary>
    public double? EstimateDays { get; set; }

    /// <summary>计划开始时间（甘特图用）</summary>
    public DateTime? StartAt { get; set; }

    /// <summary>截止时间（甘特图用）</summary>
    public DateTime? DueAt { get; set; }

    /// <summary>前置依赖任务 ID 列表（甘特图依赖连线）</summary>
    public List<string> DependsOn { get; set; } = new();

    /// <summary>标签</summary>
    public List<string> Labels { get; set; } = new();

    /// <summary>同列排序键（看板拖拽排序）</summary>
    public double OrderKey { get; set; }

    /// <summary>进度百分比 0-100（叶子任务手填或工作日志带入；父任务由子任务自动汇总）</summary>
    public int ProgressPercent { get; set; }

    /// <summary>是否由子任务自动汇总进度（有子任务的父任务默认 true；叶子任务手填进度后置 false）</summary>
    public bool AutoProgress { get; set; } = true;

    /// <summary>来源类型：manual(手动创建) / ai_decompose(AI 拆解)</summary>
    public string Source { get; set; } = PmTaskSource.Manual;

    /// <summary>来源锚点 — AI 拆解时回填，标明源自需求文档哪一段（可追溯）</summary>
    public string? SourceRef { get; set; }

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>进度裁剪到 0-100。</summary>
    public static int ClampProgress(int v) => v < 0 ? 0 : v > 100 ? 100 : v;

    /// <summary>
    /// 父任务进度 = 各直属子任务进度均值（done=100 / cancelled=0 / 其余取各自 ProgressPercent，裁剪到 0-100）。
    /// 无子任务返回 null（调用方据此决定不覆盖父任务进度）。纯函数，便于单测。
    /// </summary>
    public static int? ComputeParentProgress(IReadOnlyCollection<PmTask> children)
    {
        if (children == null || children.Count == 0) return null;
        var sum = 0;
        foreach (var c in children)
        {
            sum += c.Status == PmTaskStatus.Done ? 100
                 : c.Status == PmTaskStatus.Cancelled ? 0
                 : ClampProgress(c.ProgressPercent);
        }
        return (int)Math.Round((double)sum / children.Count);
    }
}

/// <summary>任务状态常量</summary>
public static class PmTaskStatus
{
    public const string Backlog = "backlog";
    public const string Todo = "todo";
    public const string InProgress = "in_progress";
    public const string Done = "done";
    public const string Cancelled = "cancelled";

    public static readonly string[] All = { Backlog, Todo, InProgress, Done, Cancelled };
}

/// <summary>任务优先级常量</summary>
public static class PmTaskPriority
{
    public const string Urgent = "urgent";
    public const string High = "high";
    public const string Medium = "medium";
    public const string Low = "low";
    public const string None = "none";

    public static readonly string[] All = { Urgent, High, Medium, Low, None };
}

/// <summary>任务来源常量</summary>
public static class PmTaskSource
{
    public const string Manual = "manual";
    public const string AiDecompose = "ai_decompose";
}
