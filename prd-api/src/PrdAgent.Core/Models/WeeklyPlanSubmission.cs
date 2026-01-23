namespace PrdAgent.Core.Models;

/// <summary>
/// 周计划提交 - 用户根据模板填写的计划内容
/// </summary>
public class WeeklyPlanSubmission
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>使用的模板 ID</summary>
    public string TemplateId { get; set; } = string.Empty;

    /// <summary>模板名称快照（避免模板删除后丢失上下文）</summary>
    public string TemplateName { get; set; } = string.Empty;

    /// <summary>提交者 userId</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>提交者显示名称（快照）</summary>
    public string UserDisplayName { get; set; } = string.Empty;

    /// <summary>计划周期开始日期（ISO 日期，通常为周一）</summary>
    public DateTime PeriodStart { get; set; }

    /// <summary>计划周期结束日期（ISO 日期，通常为周日）</summary>
    public DateTime PeriodEnd { get; set; }

    /// <summary>
    /// 状态：
    /// - draft: 草稿（可继续编辑）
    /// - submitted: 已提交（等待审阅）
    /// - reviewed: 已审阅
    /// </summary>
    public string Status { get; set; } = "draft";

    /// <summary>各段落的填写内容</summary>
    public List<PlanSectionEntry> Entries { get; set; } = new();

    /// <summary>提交时间</summary>
    public DateTime? SubmittedAt { get; set; }

    /// <summary>审阅人 userId</summary>
    public string? ReviewedBy { get; set; }

    /// <summary>审阅时间</summary>
    public DateTime? ReviewedAt { get; set; }

    /// <summary>审阅评语</summary>
    public string? ReviewComment { get; set; }

    /// <summary>从上周遗留任务自动带入的 submissionId</summary>
    public string? CarryOverFromId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 计划段落填写内容
/// </summary>
public class PlanSectionEntry
{
    /// <summary>对应模板段落的 ID</summary>
    public string SectionId { get; set; } = string.Empty;

    /// <summary>
    /// 填写的值（根据段落类型不同，结构不同）：
    /// - text: string
    /// - list: List&lt;string&gt;
    /// - table: List&lt;Dictionary&lt;string, object&gt;&gt;
    /// - progress: int (0-100)
    /// - checklist: List&lt;ChecklistItem&gt;
    /// </summary>
    public object? Value { get; set; }
}

/// <summary>
/// 勾选列表项
/// </summary>
public class ChecklistItem
{
    /// <summary>文本内容</summary>
    public string Text { get; set; } = string.Empty;

    /// <summary>是否已勾选</summary>
    public bool Checked { get; set; }
}
