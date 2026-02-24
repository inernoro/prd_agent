namespace PrdAgent.Core.Models;

/// <summary>
/// 邮件处理意图
/// </summary>
public enum EmailIntentType
{
    /// <summary>未知意图</summary>
    Unknown,

    /// <summary>邮件分类</summary>
    Classify,

    /// <summary>创建待办</summary>
    CreateTodo,

    /// <summary>内容摘要</summary>
    Summarize,

    /// <summary>需要跟进</summary>
    FollowUp,

    /// <summary>仅供参考，无需处理</summary>
    FYI
}

/// <summary>
/// 邮件意图检测结果
/// </summary>
public class EmailIntent
{
    public EmailIntentType Type { get; set; } = EmailIntentType.Unknown;

    /// <summary>置信度 0-1</summary>
    public double Confidence { get; set; }

    /// <summary>检测依据说明</summary>
    public string? Reason { get; set; }

    /// <summary>提取的参数（如截止日期、优先级等）</summary>
    public Dictionary<string, string> Parameters { get; set; } = new();
}

/// <summary>
/// 邮件处理结果
/// </summary>
public class EmailHandleResult
{
    public bool Success { get; set; }
    public string Message { get; set; } = "";
    public string? Details { get; set; }

    /// <summary>关联的实体ID（如待办ID）</summary>
    public string? EntityId { get; set; }

    /// <summary>处理后的数据</summary>
    public Dictionary<string, object>? Data { get; set; }

    public static EmailHandleResult Ok(string message, string? details = null) =>
        new() { Success = true, Message = message, Details = details };

    public static EmailHandleResult Fail(string message, string? details = null) =>
        new() { Success = false, Message = message, Details = details };
}

/// <summary>
/// 待办事项
/// </summary>
public class TodoItem
{
    public string Id { get; set; } = MongoDB.Bson.ObjectId.GenerateNewId().ToString();

    /// <summary>所属用户ID</summary>
    public string UserId { get; set; } = "";

    /// <summary>标题</summary>
    public string Title { get; set; } = "";

    /// <summary>描述/内容</summary>
    public string? Description { get; set; }

    /// <summary>来源类型（email/manual）</summary>
    public string Source { get; set; } = "email";

    /// <summary>来源ID（如邮件任务ID）</summary>
    public string? SourceId { get; set; }

    /// <summary>来源详情（如发件人、主题）</summary>
    public Dictionary<string, string> SourceMeta { get; set; } = new();

    /// <summary>优先级（1-5，5最高）</summary>
    public int Priority { get; set; } = 3;

    /// <summary>截止日期</summary>
    public DateTime? DueDate { get; set; }

    /// <summary>状态（pending/in_progress/completed/cancelled）</summary>
    public string Status { get; set; } = "pending";

    /// <summary>标签</summary>
    public List<string> Tags { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
}

/// <summary>
/// 邮件分类结果
/// </summary>
public class EmailClassification
{
    public string Id { get; set; } = MongoDB.Bson.ObjectId.GenerateNewId().ToString();

    /// <summary>来源任务ID</summary>
    public string TaskId { get; set; } = "";

    /// <summary>主分类</summary>
    public string Category { get; set; } = "";

    /// <summary>子分类</summary>
    public string? SubCategory { get; set; }

    /// <summary>紧急程度（low/medium/high/urgent）</summary>
    public string Urgency { get; set; } = "medium";

    /// <summary>是否需要回复</summary>
    public bool NeedsReply { get; set; }

    /// <summary>建议的处理方式</summary>
    public string? SuggestedAction { get; set; }

    /// <summary>关键词/标签</summary>
    public List<string> Keywords { get; set; } = new();

    /// <summary>内容摘要</summary>
    public string? Summary { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
