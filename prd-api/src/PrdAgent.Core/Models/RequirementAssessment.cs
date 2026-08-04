namespace PrdAgent.Core.Models;

/// <summary>
/// 产品评审员 — 需求评估任务（一次 Excel 需求表的批量评估）
/// </summary>
public class RequirementAssessmentRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>发起人 UserId</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>发起人展示名</summary>
    public string OwnerName { get; set; } = string.Empty;

    /// <summary>评估任务标题（默认取文件名）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>原始文件名（.xls / .xlsx）</summary>
    public string FileName { get; set; } = string.Empty;

    /// <summary>解析来源工作表名</summary>
    public string SheetName { get; set; } = string.Empty;

    /// <summary>表头（按列顺序）</summary>
    public List<string> Headers { get; set; } = new();

    /// <summary>解析出的数据行（与 Headers 对齐；创建 Item 后仅作留档）</summary>
    public List<List<string>> Rows { get; set; } = new();

    /// <summary>数据总行数（截断前）</summary>
    public int TotalRowCount { get; set; }

    /// <summary>行数超上限被截断</summary>
    public bool Truncated { get; set; }

    /// <summary>需求名称列索引（评估前必须确认）</summary>
    public int? NameColumnIndex { get; set; }

    /// <summary>需求描述列索引（可空）</summary>
    public int? DescColumnIndex { get; set; }

    /// <summary>因子 → 证据来源列索引（启发式 + LLM 自动综合）</summary>
    public Dictionary<string, List<int>> FactorColumnMapping { get; set; } = new();

    /// <summary>列映射是否已经过 LLM 精化（评估流开始时执行一次，避免重试时重复调用）</summary>
    public bool MappingRefined { get; set; }

    /// <summary>评估时使用的因子权重快照（防后续规则调整影响历史报告复算）</summary>
    public List<RequirementFactorWeightSnapshot> WeightsSnapshot { get; set; } = new();

    /// <summary>状态：Draft / Queued / Running / Done / Error</summary>
    public string Status { get; set; } = RequirementAssessmentStatuses.Draft;

    /// <summary>已完成评分的需求条数（进度展示）</summary>
    public int ScoredCount { get; set; }

    /// <summary>需求总条数（= Items 数）</summary>
    public int ItemCount { get; set; }

    /// <summary>整体报告 Markdown（Done 后填写）</summary>
    public string? ReportMarkdown { get; set; }

    /// <summary>全表级缺失提醒（如"全表无签约信息列，签约紧迫度按保守值计"）</summary>
    public List<string> GlobalMissingHints { get; set; } = new();

    public string? ErrorMessage { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
}

public static class RequirementAssessmentStatuses
{
    public const string Draft = "Draft";
    public const string Queued = "Queued";
    public const string Running = "Running";
    public const string Done = "Done";
    public const string Error = "Error";
}

/// <summary>权重快照条目</summary>
public class RequirementFactorWeightSnapshot
{
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public int Weight { get; set; }
}

/// <summary>
/// 产品评审员 — 单条需求的评估结果
/// </summary>
public class RequirementAssessmentItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属评估任务</summary>
    public string RunId { get; set; } = string.Empty;

    /// <summary>Excel 中的数据行号（从 1 开始，不含表头；同分决胜链最后一环）</summary>
    public int RowIndex { get; set; }

    /// <summary>需求名称（取自名称列）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>该行全部原始字段（表头 → 单元格值，评估依据展示用）</summary>
    public Dictionary<string, string> RawFields { get; set; } = new();

    /// <summary>八因子评分明细</summary>
    public List<RequirementFactorScore> FactorScores { get; set; } = new();

    /// <summary>加权总分（0-100，一位小数，系统计算）</summary>
    public double TotalScore { get; set; }

    /// <summary>证据齐全度（有证据因子数 / 因子总数，0-100）</summary>
    public int ConfidencePercent { get; set; }

    /// <summary>缺失信息清单（建议补充哪些字段）</summary>
    public List<string> MissingInfo { get; set; } = new();

    /// <summary>一句话评估结论（LLM 输出）</summary>
    public string Conclusion { get; set; } = string.Empty;

    /// <summary>全局优先级序号（1 起，数字越小越优先；Done 后填写）</summary>
    public int? Priority { get; set; }

    /// <summary>分档：P0 / P1 / P2 / P3</summary>
    public string? Tier { get; set; }

    /// <summary>是否触发签约强制置顶（签约且临期，排序时优先于普通需求）</summary>
    public bool IsContractualOverride { get; set; }

    /// <summary>系统兜底调整日志（锚点钳制 / 证据缺失保守化等）</summary>
    public List<string> AdjustmentLog { get; set; } = new();

    /// <summary>状态：Pending / Scored / Error</summary>
    public string Status { get; set; } = RequirementItemStatuses.Pending;

    public string? ErrorMessage { get; set; }

    public DateTime? ScoredAt { get; set; }
}

public static class RequirementItemStatuses
{
    public const string Pending = "Pending";
    public const string Scored = "Scored";
    public const string Error = "Error";
}

/// <summary>单因子评分</summary>
public class RequirementFactorScore
{
    /// <summary>因子 key（对应 RequirementFactorCatalog）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>因子名称快照</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>锚点分 1-5（证据缺失时为系统保守化后的值；LLM 原始值见 OriginalAnchor）</summary>
    public int Anchor { get; set; }

    /// <summary>LLM 原始锚点分（仅当被系统调整时填充）</summary>
    public int? OriginalAnchor { get; set; }

    /// <summary>权重快照</summary>
    public int Weight { get; set; }

    /// <summary>加权得分 = Anchor x Weight / 5（一位小数，系统计算）</summary>
    public double WeightedScore { get; set; }

    /// <summary>是否有表格原文证据</summary>
    public bool HasEvidence { get; set; }

    /// <summary>证据（引用表格原文，如"客户反馈列='华为等8家' → 4 分"）</summary>
    public string Evidence { get; set; } = string.Empty;
}
