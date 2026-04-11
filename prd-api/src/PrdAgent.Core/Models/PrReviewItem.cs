namespace PrdAgent.Core.Models;

/// <summary>
/// PR Review V2：一条用户级 PR 审查记录。
/// 用户通过粘贴 PR URL 添加，自动拉取最新 GitHub 数据写入 Snapshot。
/// 记录按 UserId 严格隔离，不做跨用户共享。
/// </summary>
public class PrReviewItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属用户（PRD Agent UserId）</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>GitHub 组织/用户名（owner）</summary>
    public string Owner { get; set; } = string.Empty;

    /// <summary>GitHub 仓库名</summary>
    public string Repo { get; set; } = string.Empty;

    /// <summary>PR 编号</summary>
    public int Number { get; set; }

    /// <summary>原始 PR 链接（GitHub html_url，canonical）</summary>
    public string HtmlUrl { get; set; } = string.Empty;

    /// <summary>用户私人笔记（Markdown，可空）</summary>
    public string? Note { get; set; }

    /// <summary>GitHub 最新快照（为空表示尚未成功拉取）</summary>
    public PrReviewSnapshot? Snapshot { get; set; }

    /// <summary>最近一次刷新成功时间</summary>
    public DateTime? LastRefreshedAt { get; set; }

    /// <summary>最近一次刷新错误信息（为空表示正常）</summary>
    public string? LastRefreshError { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 从 GitHub Pull Request API 拉取的只读快照，直接嵌入 PrReviewItem。
/// V2 不做反规范化快照：这些字段只是"最近一次看到的 GitHub 真相"，GitHub 才是 SSOT。
/// </summary>
public class PrReviewSnapshot
{
    /// <summary>PR 标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>PR 状态：open / closed / merged</summary>
    public string State { get; set; } = PrReviewStates.Open;

    /// <summary>PR 作者 GitHub login</summary>
    public string AuthorLogin { get; set; } = string.Empty;

    /// <summary>PR 作者头像 URL</summary>
    public string? AuthorAvatarUrl { get; set; }

    /// <summary>Labels 名称列表</summary>
    public List<string> Labels { get; set; } = new();

    /// <summary>新增行数</summary>
    public int Additions { get; set; }

    /// <summary>删除行数</summary>
    public int Deletions { get; set; }

    /// <summary>变更文件数</summary>
    public int ChangedFiles { get; set; }

    /// <summary>GitHub review 决策（APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED，可空）</summary>
    public string? ReviewDecision { get; set; }

    /// <summary>PR 创建时间（GitHub 原始）</summary>
    public DateTime CreatedAt { get; set; }

    /// <summary>PR 合并时间（若已合并）</summary>
    public DateTime? MergedAt { get; set; }

    /// <summary>PR 关闭时间（若已关闭）</summary>
    public DateTime? ClosedAt { get; set; }

    /// <summary>当前 head commit sha</summary>
    public string HeadSha { get; set; } = string.Empty;
}

/// <summary>PR 状态常量</summary>
public static class PrReviewStates
{
    public const string Open = "open";
    public const string Closed = "closed";
    public const string Merged = "merged";
}
