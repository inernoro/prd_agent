using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 个人数据源绑定（v2.0 — GitHub/GitLab/语雀等个人维度的数据采集配置）
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class PersonalSource
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>数据源类型：github / gitlab / yuque</summary>
    public string SourceType { get; set; } = PersonalSourceType.GitHub;

    /// <summary>显示名称（如 "我的 GitHub"）</summary>
    public string DisplayName { get; set; } = string.Empty;

    /// <summary>类型相关配置</summary>
    public PersonalSourceConfig Config { get; set; } = new();

    /// <summary>访问令牌（AES-256 加密存储，通过 ApiKeyCrypto）</summary>
    public string? EncryptedToken { get; set; }

    /// <summary>是否启用</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>上次同步时间</summary>
    public DateTime? LastSyncAt { get; set; }

    /// <summary>上次同步状态：success / failed / never</summary>
    public string LastSyncStatus { get; set; } = PersonalSourceSyncStatus.Never;

    /// <summary>上次同步错误信息</summary>
    public string? LastSyncError { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 个人数据源类型相关配置
/// </summary>
public class PersonalSourceConfig
{
    /// <summary>仓库地址（Git 类）如 "https://github.com/user/repo"</summary>
    public string? RepoUrl { get; set; }

    /// <summary>用户名（用于 commit 匹配）</summary>
    public string? Username { get; set; }

    /// <summary>空间 ID（语雀）</summary>
    public string? SpaceId { get; set; }

    /// <summary>API 端点（自定义）</summary>
    public string? ApiEndpoint { get; set; }
}

/// <summary>
/// 个人数据源类型常量
/// </summary>
public static class PersonalSourceType
{
    public const string GitHub = "github";
    public const string GitLab = "gitlab";
    public const string Yuque = "yuque";

    public static readonly string[] All = { GitHub, GitLab, Yuque };
}

/// <summary>
/// 个人数据源同步状态常量
/// </summary>
public static class PersonalSourceSyncStatus
{
    public const string Success = "success";
    public const string Failed = "failed";
    public const string Never = "never";
}
