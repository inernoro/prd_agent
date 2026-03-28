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
}
