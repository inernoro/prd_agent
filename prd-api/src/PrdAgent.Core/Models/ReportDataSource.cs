using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 数据源配置（Git/SVN 仓库连接）
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class ReportDataSource
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联团队 ID</summary>
    public string TeamId { get; set; } = string.Empty;

    /// <summary>数据源类型：git / svn（Phase 4）</summary>
    public string SourceType { get; set; } = DataSourceType.Git;

    /// <summary>显示名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>仓库地址</summary>
    public string RepoUrl { get; set; } = string.Empty;

    /// <summary>访问令牌（AES-256 加密存储，通过 ApiKeyCrypto）</summary>
    public string? EncryptedAccessToken { get; set; }

    /// <summary>监听分支过滤（逗号分隔，如 "main,develop,release/*"）</summary>
    public string? BranchFilter { get; set; }

    /// <summary>用户映射表（git author email/name → MAP userId）</summary>
    public Dictionary<string, string> UserMapping { get; set; } = new();

    /// <summary>轮询间隔（分钟）</summary>
    public int PollIntervalMinutes { get; set; } = 60;

    /// <summary>是否启用</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>最后一次同步时间</summary>
    public DateTime? LastSyncAt { get; set; }

    /// <summary>最后一次同步错误信息</summary>
    public string? LastSyncError { get; set; }

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 数据源类型常量
/// </summary>
public static class DataSourceType
{
    public const string Git = "git";
    public const string Svn = "svn";

    public static readonly string[] All = { Git, Svn };
}
