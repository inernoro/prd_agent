using System.Security.Cryptography;
using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 周报分享链接 — 团队某周聚合视图的外发分享（登录后访问，团队成员免密码，非成员需密码）
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class ReportShareLink
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>短 Token（用于 URL）</summary>
    public string Token { get; set; } = GenerateToken();

    /// <summary>所属团队 ID</summary>
    public string TeamId { get; set; } = string.Empty;

    /// <summary>团队名称（快照）</summary>
    public string? TeamName { get; set; }

    /// <summary>ISO 周年</summary>
    public int WeekYear { get; set; }

    /// <summary>ISO 周数</summary>
    public int WeekNumber { get; set; }

    /// <summary>访问级别：public = 任何已登录用户可看 | password = 非团队成员需密码</summary>
    public string AccessLevel { get; set; } = "public";

    /// <summary>访问密码（AccessLevel = password 时有效，明文存储以便展示给分享者）</summary>
    public string? Password { get; set; }

    /// <summary>过期时间（null 表示永不过期）</summary>
    public DateTime? ExpiresAt { get; set; }

    /// <summary>已撤销</summary>
    public bool IsRevoked { get; set; }

    /// <summary>查看次数</summary>
    public long ViewCount { get; set; }

    /// <summary>最近查看时间</summary>
    public DateTime? LastViewedAt { get; set; }

    /// <summary>创建者 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>创建者显示名称（快照）</summary>
    public string? CreatedByName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    private static string GenerateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(9))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}

/// <summary>
/// 访问级别常量
/// </summary>
public static class ReportShareAccessLevel
{
    /// <summary>任何已登录用户可看</summary>
    public const string Public = "public";

    /// <summary>非团队成员需密码</summary>
    public const string Password = "password";
}
