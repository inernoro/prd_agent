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

    private static string GenerateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(9))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}

public static class DefectShareScopeType
{
    public const string Single = "single";
    public const string Project = "project";
    public const string Selected = "selected";
}
