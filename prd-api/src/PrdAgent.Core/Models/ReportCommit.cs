using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 代码提交缓存（从 Git/SVN 同步）
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class ReportCommit
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属数据源 ID</summary>
    public string DataSourceId { get; set; } = string.Empty;

    /// <summary>映射的 MAP 用户 ID（通过 UserMapping 转换）</summary>
    public string? MappedUserId { get; set; }

    /// <summary>Git 提交者名称</summary>
    public string AuthorName { get; set; } = string.Empty;

    /// <summary>Git 提交者邮箱</summary>
    public string AuthorEmail { get; set; } = string.Empty;

    /// <summary>Commit Hash（唯一索引 DataSourceId+CommitHash）</summary>
    public string CommitHash { get; set; } = string.Empty;

    /// <summary>提交消息</summary>
    public string Message { get; set; } = string.Empty;

    /// <summary>提交时间</summary>
    public DateTime CommittedAt { get; set; }

    /// <summary>分支名称</summary>
    public string? Branch { get; set; }

    /// <summary>新增行数</summary>
    public int Additions { get; set; }

    /// <summary>删除行数</summary>
    public int Deletions { get; set; }

    /// <summary>变更文件数</summary>
    public int FilesChanged { get; set; }

    /// <summary>同步入库时间</summary>
    public DateTime SyncedAt { get; set; } = DateTime.UtcNow;
}
