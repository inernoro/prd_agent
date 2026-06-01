namespace PrdAgent.Core.Models;

/// <summary>
/// 项目决策事项 — 记录项目推进过程中的关键决策与待办判断。
/// 三态：pending(待决策) / decided(已决策) / memo(备忘)。
/// pending 流转到 decided 时落 DecidedBy/DecidedByName/DecidedAt。
/// </summary>
public class PmDecision
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属项目</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>决策标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>详细说明（背景 / 决策内容 / 影响）</summary>
    public string? Content { get; set; }

    /// <summary>状态：pending | decided | memo</summary>
    public string Type { get; set; } = PmDecisionType.Pending;

    /// <summary>定案人 UserId（decided 时填）</summary>
    public string? DecidedBy { get; set; }

    /// <summary>定案人名称（冗余，便于展示）</summary>
    public string? DecidedByName { get; set; }

    /// <summary>定案时间（decided 时填）</summary>
    public DateTime? DecidedAt { get; set; }

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>创建人名称（冗余）</summary>
    public string? CreatedByName { get; set; }

    /// <summary>关联目标 ID 列表（可空）—— 本决策影响/源自哪些业务目标，便于从目标反查决策。</summary>
    public List<string> RelatedGoalIds { get; set; } = new();

    /// <summary>关联任务 ID 列表（可空）—— 本决策影响/牵动哪些执行项。</summary>
    public List<string> RelatedTaskIds { get; set; } = new();

    /// <summary>同状态内排序键（越小越靠前）</summary>
    public long OrderKey { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>决策状态枚举</summary>
public static class PmDecisionType
{
    public const string Pending = "pending";
    public const string Decided = "decided";
    public const string Memo = "memo";

    public static bool IsValid(string? v) => v is Pending or Decided or Memo;
}
