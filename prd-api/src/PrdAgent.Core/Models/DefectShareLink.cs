using System.Security.Cryptography;

namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷分享链接 — 用于将缺陷数据分享给外部 Agent 分析
/// </summary>
public class DefectShareLink
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>短 Token（用于 URL）</summary>
    public string Token { get; set; } = GenerateToken();

    /// <summary>分享范围：single = 单个缺陷, project = 按项目, selected = 手动选择</summary>
    public string ShareScope { get; set; } = DefectShareScopeType.Single;

    /// <summary>关联的缺陷 ID 列表（scope = single 或 selected 时使用）</summary>
    public List<string> DefectIds { get; set; } = new();

    /// <summary>关联的项目 ID（scope = project 时使用）</summary>
    public string? ProjectId { get; set; }

    /// <summary>项目名称（快照）</summary>
    public string? ProjectName { get; set; }

    /// <summary>分享标题</summary>
    public string? Title { get; set; }

    public long ViewCount { get; set; }
    public DateTime? LastViewedAt { get; set; }

    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>创建者显示名称（快照）</summary>
    public string? CreatedByName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>过期时间（必填，默认 3 天）</summary>
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddDays(3);

    public bool IsRevoked { get; set; }

    /// <summary>AI 评分结果列表（一键分享时 LLM 自动评分）</summary>
    public List<DefectAiScoreItem>? AiScores { get; set; }

    /// <summary>AI 评分状态：none | scoring | completed | failed</summary>
    public string AiScoreStatus { get; set; } = AiScoreStatusType.None;

    private static string GenerateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(9))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}

/// <summary>
/// 缺陷 AI 评分条目
/// </summary>
public class DefectAiScoreItem
{
    /// <summary>缺陷 ID</summary>
    public string DefectId { get; set; } = string.Empty;

    /// <summary>缺陷编号（快照）</summary>
    public string? DefectNo { get; set; }

    /// <summary>缺陷标题（快照）</summary>
    public string? DefectTitle { get; set; }

    /// <summary>严重程度评分（1-10）</summary>
    public int SeverityScore { get; set; }

    /// <summary>修复难度评分（1-10）</summary>
    public int DifficultyScore { get; set; }

    /// <summary>影响范围评分（1-10）</summary>
    public int ImpactScore { get; set; }

    /// <summary>综合优先级评分（1-10）</summary>
    public int OverallScore { get; set; }

    /// <summary>AI 评分理由</summary>
    public string? Reason { get; set; }
}

public static class AiScoreStatusType
{
    public const string None = "none";
    public const string Scoring = "scoring";
    public const string Completed = "completed";
    public const string Failed = "failed";
}

public static class DefectShareScopeType
{
    public const string Single = "single";
    public const string Project = "project";
    public const string Selected = "selected";
}
