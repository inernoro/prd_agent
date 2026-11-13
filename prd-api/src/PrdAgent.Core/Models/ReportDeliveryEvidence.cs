namespace PrdAgent.Core.Models;

/// <summary>报告采集的不可变事实。保存于周报快照，不产生新的员工评价或提交动作。</summary>
public class ReportEvidenceLedger
{
    public int SchemaVersion { get; set; } = 1;
    public bool HistoryComplete { get; set; }
    public List<ReportEvidenceWorkItem> WorkItems { get; set; } = new();
    public List<ReportEvidenceEvent> Events { get; set; } = new();
    public List<string> Limitations { get; set; } = new();
}

public class ReportEvidenceWorkItem
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? Owner { get; set; }
    public string? NextStep { get; set; }
}

public class ReportEvidenceEvent
{
    public string Id { get; set; } = string.Empty;
    public string? WorkItemId { get; set; }
    public int Order { get; set; }
    public DateTimeOffset OccurredAt { get; set; }
    public string Kind { get; set; } = "observation";
    public string? Revision { get; set; }
    public string? Scope { get; set; }
    public string? Environment { get; set; }
    public string? Reason { get; set; }
    public string TimeBasis { get; set; } = "occurred";
    public ReportEvidenceSource Source { get; set; } = new();
    /// <summary>仅采用本人明确登记的分钟数，不由跨度、提交数或模型估算。</summary>
    public int? RegisteredMinutes { get; set; }
}

public class ReportEvidenceSource
{
    public string Uri { get; set; } = string.Empty;
    public string Excerpt { get; set; } = string.Empty;
}

public class ReportEvidenceCitation
{
    public string Id { get; set; } = string.Empty;
    public string Uri { get; set; } = string.Empty;
    public string Excerpt { get; set; } = string.Empty;
    public DateTimeOffset OccurredAt { get; set; }
    public string Kind { get; set; } = string.Empty;
    public string? Revision { get; set; }
}

/// <summary>由事实重建的只读管理视图；模型不能覆盖其中的阶段、数字或来源。</summary>
public class ReportDeliverySnapshot
{
    public int SchemaVersion { get; set; } = 1;
    public DateTime PeriodStart { get; set; }
    public DateTime PeriodEnd { get; set; }
    public string TimeZone { get; set; } = "Asia/Shanghai";
    public string Headline { get; set; } = string.Empty;
    public List<ReportDeliveryItem> Items { get; set; } = new();
    public List<string> Limitations { get; set; } = new();
    public List<ReportEvidenceMetric> Metrics { get; set; } = new();
    public Dictionary<string, int?> NewMilestones { get; set; } = new();
    public int UnassignedEvidenceCount { get; set; }
    public string InputDigest { get; set; } = string.Empty;
}

public class ReportDeliveryItem
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? Owner { get; set; }
    public string Movement { get; set; } = string.Empty;
    public string PreviousSummary { get; set; } = string.Empty;
    public string CodeStatus { get; set; } = "unknown";
    public string CodeLabel { get; set; } = "未证实";
    public string ValidationStatus { get; set; } = "unknown";
    public string ValidationLabel { get; set; } = "未证实";
    public string ReleaseStatus { get; set; } = "unknown";
    public string ReleaseLabel { get; set; } = "未证实";
    public string? Revision { get; set; }
    public string? BlockReason { get; set; }
    public string? NextStep { get; set; }
    public List<ReportEvidenceCitation> Sources { get; set; } = new();
    public List<string> NewMilestones { get; set; } = new();
}

public class ReportEvidenceMetric
{
    public string Key { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public bool Available { get; set; }
    public string Text { get; set; } = string.Empty;
    public List<ReportEvidenceCitation> Sources { get; set; } = new();
}
