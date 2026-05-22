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

    /// <summary>
    /// 明文密码 —— 仅旧分享和"创建时按密码去重展示给分享者"使用。
    /// 新分享统一以 PasswordHash + PasswordSalt 存储；校验路径优先 Hash，
    /// 仅在 PasswordHash 为空时回退到本字段（向后兼容存量数据）。
    /// </summary>
    public string? Password { get; set; }

    /// <summary>密码 Hash (PBKDF2-SHA256, base64)。新分享必填；旧分享为空时走明文回退路径</summary>
    public string? PasswordHash { get; set; }

    /// <summary>密码盐 (16 bytes base64)。与 PasswordHash 配对，缺一个就视为旧分享</summary>
    public string? PasswordSalt { get; set; }

    /// <summary>
    /// 最近 N 次尝试时间戳（滑动窗口速率限制，单位 UTC）。
    /// 不按 IP 锁定 —— 容器/反向代理下 IP 不可靠，且 NAT 局域网下一人输错全部门遭殃。
    /// 改用 per-shareLink 滑动窗口：1 分钟内 ≥ 10 次尝试就拒绝。窗口自然滚动过期。
    /// </summary>
    public List<DateTime> RecentAttempts { get; set; } = new();

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
