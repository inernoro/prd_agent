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

    /// <summary>
    /// 最近一次 AI 对齐度检查结果（最新一次覆盖旧的，不做历史）。
    /// 为空表示还没跑过 AI 对齐分析。
    /// </summary>
    public AlignmentReport? AlignmentReport { get; set; }

    /// <summary>
    /// 最近一次 AI 变更摘要结果（最新一次覆盖旧的，不做历史）。
    /// 为空表示还没跑过 AI 摘要。
    /// </summary>
    public SummaryReport? SummaryReport { get; set; }

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

    /// <summary>PR 作者原始描述（body，Markdown）。截断到 20KB 防 MongoDB 单文档膨胀。</summary>
    public string? Body { get; set; }

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

    /// <summary>
    /// 变更文件摘要（按 GitHub /pulls/{n}/files 返回截断）。
    /// V1 最多留前 80 个文件，每个 patch 截断到 4KB，总大小控制在单文档可承受范围内。
    /// </summary>
    public List<PrFileSummary> Files { get; set; } = new();

    /// <summary>从 PR body 里解析出的关联 issue 编号（如 Closes #123 里的 123）。无则为 null。</summary>
    public int? LinkedIssueNumber { get; set; }

    /// <summary>关联 issue 标题（冗余存储便于 UI 展示）</summary>
    public string? LinkedIssueTitle { get; set; }

    /// <summary>关联 issue 原始 body（截断到 8KB）</summary>
    public string? LinkedIssueBody { get; set; }
}

/// <summary>
/// 单个 PR 变更文件的摘要（for AI 对齐度分析）。
/// Patch 字段存的是 unified diff 片段，已被 GitHubPrClient 截断到 4KB。
/// </summary>
public class PrFileSummary
{
    public string Filename { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty; // added / modified / removed / renamed
    public int Additions { get; set; }
    public int Deletions { get; set; }
    public string? Patch { get; set; } // unified diff 片段，可能为 null（二进制文件）
}

/// <summary>
/// AI 变更摘要结果。档 1 —— 30 秒看懂一个 PR 在做什么。
/// 输出是 Markdown 正文（含"一句话 / 关键改动 / 主要影响 / 审查建议"四节），
/// 前端按章节渲染，不做任何分数抽取。
/// </summary>
public class SummaryReport
{
    /// <summary>LLM 原始 Markdown 输出</summary>
    public string Markdown { get; set; } = string.Empty;

    /// <summary>一句话摘要（从 Markdown 里抽出便于列表页展示）</summary>
    public string? Headline { get; set; }

    /// <summary>本次分析用的模型 ID（日志 & 可观测性）</summary>
    public string? Model { get; set; }

    /// <summary>分析耗时（毫秒）</summary>
    public long DurationMs { get; set; }

    /// <summary>生成时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>错误信息（失败时有值）</summary>
    public string? Error { get; set; }
}

/// <summary>
/// AI 对齐度检查结果。档 3 —— 把 PR 描述与实际变更对齐。
/// 结果以 Markdown 正文 + 可解析的分数字段存储，前端既能渲染 Markdown 也能拿分数做可视化。
/// </summary>
public class AlignmentReport
{
    /// <summary>对齐度分数 0-100（从 LLM 输出的第一行抽取）</summary>
    public int Score { get; set; }

    /// <summary>LLM 原始 Markdown 输出（含总结 / 已落实 / 没提但动了 / 提了没见到）</summary>
    public string Markdown { get; set; } = string.Empty;

    /// <summary>解析出的摘要一句话（便于列表页展示）</summary>
    public string? Summary { get; set; }

    /// <summary>本次分析用的模型 ID（日志 & 可观测性）</summary>
    public string? Model { get; set; }

    /// <summary>分析耗时（毫秒）</summary>
    public long DurationMs { get; set; }

    /// <summary>生成时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>错误信息（失败时有值）</summary>
    public string? Error { get; set; }
}

/// <summary>PR 状态常量</summary>
public static class PrReviewStates
{
    public const string Open = "open";
    public const string Closed = "closed";
    public const string Merged = "merged";
}
