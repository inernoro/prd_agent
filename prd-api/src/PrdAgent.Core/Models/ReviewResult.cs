namespace PrdAgent.Core.Models;

/// <summary>
/// 产品评审员 — 评审结果（含分项分）
/// </summary>
public class ReviewResult
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的提交 ID</summary>
    public string SubmissionId { get; set; } = string.Empty;

    /// <summary>各维度评分</summary>
    public List<ReviewDimensionScore> DimensionScores { get; set; } = new();

    /// <summary>总分（0-100）</summary>
    public int TotalScore { get; set; }

    /// <summary>是否通过（总分 ≥ 80）</summary>
    public bool IsPassed { get; set; }

    /// <summary>AI 总结评语（Markdown 格式）</summary>
    public string Summary { get; set; } = string.Empty;

    /// <summary>完整评审报告（Markdown）</summary>
    public string FullMarkdown { get; set; } = string.Empty;

    /// <summary>解析错误信息（为空表示解析成功）</summary>
    public string? ParseError { get; set; }

    public DateTime ScoredAt { get; set; } = DateTime.UtcNow;
}

/// <summary>单维度评分</summary>
public class ReviewDimensionScore
{
    /// <summary>维度标识 key</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>维度名称快照</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>实得分</summary>
    public int Score { get; set; }

    /// <summary>满分</summary>
    public int MaxScore { get; set; }

    /// <summary>AI 评语（该维度的具体评价）</summary>
    public string Comment { get; set; } = string.Empty;

    /// <summary>子检查项判断结果（清单类维度使用，普通维度为 null）</summary>
    public List<DimensionCheckItemResult>? Items { get; set; }
}

/// <summary>单条检查项的 LLM 判断结果</summary>
public class DimensionCheckItemResult
{
    /// <summary>对应 DimensionCheckItem.Id</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>分类快照</summary>
    public string Category { get; set; } = string.Empty;

    /// <summary>检查项名称快照</summary>
    public string Text { get; set; } = string.Empty;

    /// <summary>LLM 判断：方案是否涉及该规则</summary>
    public bool Involved { get; set; }

    /// <summary>LLM 判断：方案是否已覆盖该规则（仅当 Involved=true 时有意义）</summary>
    public bool Covered { get; set; }

    /// <summary>判断依据/原文证据/缺失说明（≤80 字）</summary>
    public string? Evidence { get; set; }
}
