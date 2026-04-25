namespace PrdAgent.Core.Models;

public class PaTask
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    public string? SessionId { get; set; }
    public string Title { get; set; } = string.Empty;
    public List<PaSubTask> SubTasks { get; set; } = new();
    public string Quadrant { get; set; } = PaTaskQuadrant.Q2;
    public string Status { get; set; } = PaTaskStatus.Pending;
    public DateTime? Deadline { get; set; }
    public string? Reasoning { get; set; }
    public string? ContentHash { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class PaSubTask
{
    public string Content { get; set; } = string.Empty;
    public bool Done { get; set; } = false;
}

public static class PaTaskStatus
{
    public const string Pending = "pending";
    public const string Done = "done";
    public const string Archived = "archived";
    public static readonly string[] All = { Pending, Done, Archived };
}

public static class PaTaskQuadrant
{
    public const string Q1 = "Q1";
    public const string Q2 = "Q2";
    public const string Q3 = "Q3";
    public const string Q4 = "Q4";
    public static readonly string[] All = { Q1, Q2, Q3, Q4 };
}

public class PaMessage
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public string? TaskJson { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class PaSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    /// <summary>会话标题（首条消息自动生成）</summary>
    public string Title { get; set; } = "新对话";
    /// <summary>最后一条消息摘要（用于侧边栏预览）</summary>
    public string? LastMessagePreview { get; set; }
    /// <summary>消息总数</summary>
    public int MessageCount { get; set; } = 0;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>任务意图置信度</summary>
public static class PaTaskConfidence
{
    /// <summary>明确任务：自动加入看板</summary>
    public const string Auto = "auto";
    /// <summary>潜在任务：展示确认按钮</summary>
    public const string Suggest = "suggest";
}
