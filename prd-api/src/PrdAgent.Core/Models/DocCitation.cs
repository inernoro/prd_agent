namespace PrdAgent.Core.Models;

/// <summary>
/// PRD 引用（用于在前端定位章节并高亮原文依据）
/// 注意：该结构应仅用于 SSE/会话内传输，避免落库与日志打印。
/// </summary>
public class DocCitation
{
    /// <summary>所属章节标题（展示用）</summary>
    public string HeadingTitle { get; set; } = string.Empty;

    /// <summary>
    /// 章节锚点 ID（用于前端跳转）。
    /// 约定：与前端 MarkdownRenderer 使用 github-slugger 生成的 heading id 保持一致。
    /// </summary>
    public string HeadingId { get; set; } = string.Empty;

    /// <summary>
    /// 引用的原文片段（建议 30-120 字，纯文本，去除 markdown 语法）。
    /// 前端用于在预览页做标黄。
    /// </summary>
    public string Excerpt { get; set; } = string.Empty;

    /// <summary>可选：相关性分数（越大越相关）</summary>
    public double? Score { get; set; }

    /// <summary>可选：排序（从 1 开始）</summary>
    public int? Rank { get; set; }
}
