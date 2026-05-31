namespace PrdAgent.Core.Models;

/// <summary>
/// 任务节点 — 任务树上的每一个任务。一个分支即一个任务，
/// 父子关系表达"被依赖 → 下一个任务"，DependsOn 表达跨枝/跨树的前置依赖（DAG）。
/// </summary>
public class TaskNode
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属任务树</summary>
    public string TreeId { get; set; } = string.Empty;

    /// <summary>所属用户（反规范化，便于卡点上报跨树查询）</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>结构父节点（树形）。为空表示根节点（创世支柱）。</summary>
    public string? ParentId { get; set; }

    /// <summary>前置依赖节点 ID 列表（DAG，可跨枝/跨树）。完成这些后本任务才该开始。</summary>
    public List<string> DependsOn { get; set; } = new();

    // ── 节点内容 ──

    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }

    /// <summary>状态：idea / planned / building / done / blocked</summary>
    public string Status { get; set; } = TaskNodeStatus.Idea;

    /// <summary>卡点描述（仅 status=blocked 时有意义）</summary>
    public string? Blocker { get; set; }

    /// <summary>进入 blocked 状态的时间，用于计算"卡了多少天"。非 blocked 时为 null。</summary>
    public DateTime? BlockedSince { get; set; }

    /// <summary>同级排序权重（小在前）</summary>
    public int Order { get; set; }

    // ── 可视化（前端布局可覆盖，后端仅持久化）──

    public double PositionX { get; set; }
    public double PositionY { get; set; }

    public List<string> Tags { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>任务节点状态常量</summary>
public static class TaskNodeStatus
{
    public const string Idea = "idea";
    public const string Planned = "planned";
    public const string Building = "building";
    public const string Done = "done";
    public const string Blocked = "blocked";

    public static readonly string[] All = { Idea, Planned, Building, Done, Blocked };

    public static bool IsValid(string? s) => s != null && Array.IndexOf(All, s) >= 0;
}
