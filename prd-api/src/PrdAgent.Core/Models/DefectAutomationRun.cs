namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷自动化处理运行记录：记录一次定时/手动触发的缺陷自动修复任务。
/// </summary>
public class DefectAutomationRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>连接器类型：map-defect-agent | external</summary>
    public string ConnectorType { get; set; } = DefectSourceConnectorType.MapDefectAgent;

    /// <summary>缺陷系统访问域名</summary>
    public string Domain { get; set; } = string.Empty;

    /// <summary>授权 Key Id（不存明文 K）</summary>
    public string? AgentApiKeyId { get; set; }

    /// <summary>授权 Key 名称快照</summary>
    public string? AgentApiKeyName { get; set; }

    /// <summary>所需 scope</summary>
    public string RequiredScope { get; set; } = "defect-agent:use";

    /// <summary>触发来源：manual | schedule | api</summary>
    public string TriggerType { get; set; } = DefectAutomationTriggerType.Manual;

    public string? ProjectId { get; set; }
    public string? TeamId { get; set; }
    public string? StatusFilter { get; set; }

    /// <summary>运行状态：running | completed | failed | cancelled</summary>
    public string Status { get; set; } = DefectAutomationRunStatus.Running;

    public string? CurrentDefectId { get; set; }
    public string? CurrentDefectNo { get; set; }
    public string? CurrentDefectTitle { get; set; }

    public int TotalFetched { get; set; }
    public int TotalFixed { get; set; }
    public int TotalFailed { get; set; }

    public string? LastFailureReason { get; set; }
    public string? LastFailurePhase { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }

    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public List<DefectAutomationRunItem> Items { get; set; } = new();
}

public class DefectAutomationRunItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string DefectId { get; set; } = string.Empty;
    public string? DefectNo { get; set; }
    public string? DefectTitle { get; set; }

    /// <summary>单缺陷状态：fetched | commented | commit_written | fixed | failed</summary>
    public string Status { get; set; } = DefectAutomationRunItemStatus.Fetched;

    public int Attempts { get; set; } = 1;

    public string? CommitSha { get; set; }
    public string? ShortSha { get; set; }
    public string? CommitMessage { get; set; }
    public string? Branch { get; set; }
    public string? PreviewUrl { get; set; }
    public string? VisualReportUrl { get; set; }

    public string? FailureReason { get; set; }
    public string? FailurePhase { get; set; }

    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public static class DefectSourceConnectorType
{
    public const string MapDefectAgent = "map-defect-agent";
    public const string External = "external";
}

public static class DefectAutomationTriggerType
{
    public const string Manual = "manual";
    public const string Schedule = "schedule";
    public const string Api = "api";
}

public static class DefectAutomationRunStatus
{
    public const string Running = "running";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
}

public static class DefectAutomationRunItemStatus
{
    public const string Fetched = "fetched";
    public const string Commented = "commented";
    public const string CommitWritten = "commit_written";
    public const string Fixed = "fixed";
    public const string Failed = "failed";
}
