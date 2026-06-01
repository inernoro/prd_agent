namespace PrdAgent.Core.Models;

/// <summary>
/// 项目风险（风险登记册）—— 概率×影响矩阵 + 应对策略 + 责任人 + 状态。
/// 可选关联目标/任务，便于从风险追溯到受影响的成果/执行项。
/// </summary>
public class PmRisk
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属项目</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>风险标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>风险描述 / 触发条件 / 影响说明</summary>
    public string? Description { get; set; }

    /// <summary>发生概率：high / medium / low</summary>
    public string Probability { get; set; } = PmRiskLevel.Medium;

    /// <summary>影响程度：high / medium / low</summary>
    public string Impact { get; set; } = PmRiskLevel.Medium;

    /// <summary>应对策略：open(未应对) / avoid(规避) / transfer(转移) / mitigate(减轻) / accept(接受)</summary>
    public string Response { get; set; } = PmRiskResponse.Open;

    /// <summary>状态：open(待处理) / mitigating(应对中) / closed(已关闭)</summary>
    public string Status { get; set; } = PmRiskStatus.Open;

    /// <summary>责任人 UserId（可空）</summary>
    public string? OwnerId { get; set; }

    /// <summary>责任人名称（冗余）</summary>
    public string? OwnerName { get; set; }

    /// <summary>关联目标 ID（可空）</summary>
    public string? RelatedGoalId { get; set; }

    /// <summary>关联任务 ID（可空）</summary>
    public string? RelatedTaskId { get; set; }

    /// <summary>同项目内排序键</summary>
    public long OrderKey { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>风险概率 / 影响等级</summary>
public static class PmRiskLevel
{
    public const string High = "high";
    public const string Medium = "medium";
    public const string Low = "low";

    public static bool IsValid(string? v) => v is High or Medium or Low;
}

/// <summary>风险应对策略</summary>
public static class PmRiskResponse
{
    public const string Open = "open";
    public const string Avoid = "avoid";
    public const string Transfer = "transfer";
    public const string Mitigate = "mitigate";
    public const string Accept = "accept";

    public static bool IsValid(string? v) => v is Open or Avoid or Transfer or Mitigate or Accept;
}

/// <summary>风险状态</summary>
public static class PmRiskStatus
{
    public const string Open = "open";
    public const string Mitigating = "mitigating";
    public const string Closed = "closed";

    public static bool IsValid(string? v) => v is Open or Mitigating or Closed;
}
