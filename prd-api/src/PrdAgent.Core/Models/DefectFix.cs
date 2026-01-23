namespace PrdAgent.Core.Models;

/// <summary>
/// 修复记录
/// </summary>
public class DefectFix
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string DefectId { get; set; } = null!;
    public string? ReviewId { get; set; }

    /// <summary>修复分支名</summary>
    public string? BranchName { get; set; }

    /// <summary>PR URL</summary>
    public string? PrUrl { get; set; }

    /// <summary>PR 编号</summary>
    public int? PrNumber { get; set; }

    /// <summary>修复状态</summary>
    public FixStatus Status { get; set; }

    /// <summary>Commit SHA</summary>
    public string? CommitSha { get; set; }

    /// <summary>变更的文件列表</summary>
    public List<FileChange>? Changes { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime? MergedAt { get; set; }
}

public enum FixStatus { Pending, InProgress, PrCreated, Merged, Rejected, Failed }

public class FileChange
{
    public string FilePath { get; set; } = null!;
    public string ChangeType { get; set; } = null!; // add, modify, delete
    public int LinesAdded { get; set; }
    public int LinesRemoved { get; set; }
}
