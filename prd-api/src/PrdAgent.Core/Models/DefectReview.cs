namespace PrdAgent.Core.Models;

/// <summary>
/// AI 审核记录
/// </summary>
public class DefectReview
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string DefectId { get; set; } = null!;

    /// <summary>审核阶段</summary>
    public ReviewPhase Phase { get; set; }

    /// <summary>审核结论</summary>
    public ReviewVerdict Verdict { get; set; }

    /// <summary>AI 分析内容 (Markdown)</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>定位到的文件列表</summary>
    public List<CodeLocation>? LocatedFiles { get; set; }

    /// <summary>修复建议</summary>
    public FixSuggestion? Suggestion { get; set; }

    /// <summary>LLM 请求 ID (用于追踪)</summary>
    public string? LlmRequestId { get; set; }

    public DateTime CreatedAt { get; set; }
}

public enum ReviewPhase { Triage, Analysis, Fix, Verify }

public enum ReviewVerdict { Pass, NeedInfo, Duplicate, Invalid, CanAutoFix, NeedManualFix, MajorChange }

/// <summary>
/// 代码定位结果
/// </summary>
public class CodeLocation
{
    public string FilePath { get; set; } = null!;
    public int? StartLine { get; set; }
    public int? EndLine { get; set; }
    public string? Reason { get; set; }
    public double Confidence { get; set; }
}

/// <summary>
/// 修复建议
/// </summary>
public class FixSuggestion
{
    public FixLevel Level { get; set; }
    public string? PatchContent { get; set; }
    public string? PseudoCode { get; set; }
    public string? AnalysisReport { get; set; }
    public List<string>? AffectedFiles { get; set; }
    public string? RiskAssessment { get; set; }
}

public enum FixLevel { Auto, SemiAuto, Manual }
