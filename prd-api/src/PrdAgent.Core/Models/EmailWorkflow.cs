namespace PrdAgent.Core.Models;

/// <summary>
/// 邮件工作流配置
/// 用户可以自定义 xxx@domain 的邮箱前缀来触发不同的处理流程
/// </summary>
public class EmailWorkflow
{
    public string Id { get; set; } = MongoDB.Bson.ObjectId.GenerateNewId().ToString();

    /// <summary>
    /// 邮箱地址前缀（如 "todo"、"classify"、"bug"）
    /// 完整地址 = {AddressPrefix}@{配置的域名}
    /// </summary>
    public string AddressPrefix { get; set; } = "";

    /// <summary>
    /// 显示名称（如 "待办事项"、"邮件分类"）
    /// </summary>
    public string DisplayName { get; set; } = "";

    /// <summary>
    /// 描述说明
    /// </summary>
    public string? Description { get; set; }

    /// <summary>
    /// 图标（emoji 或图标名）
    /// </summary>
    public string? Icon { get; set; }

    /// <summary>
    /// 绑定的意图类型
    /// </summary>
    public EmailIntentType IntentType { get; set; } = EmailIntentType.Unknown;

    /// <summary>
    /// 目标 Agent（如 "defect-agent"、"prd-agent"）
    /// 如果设置，会将任务路由到指定 Agent
    /// </summary>
    public string? TargetAgent { get; set; }

    /// <summary>
    /// 自定义处理提示词（可选，用于 LLM 处理）
    /// </summary>
    public string? CustomPrompt { get; set; }

    /// <summary>
    /// 自动回复模板（可选）
    /// 支持变量：{senderName}, {subject}, {result}
    /// </summary>
    public string? ReplyTemplate { get; set; }

    /// <summary>
    /// 是否启用
    /// </summary>
    public bool IsActive { get; set; } = true;

    /// <summary>
    /// 优先级（数字越小优先级越高）
    /// </summary>
    public int Priority { get; set; } = 100;

    /// <summary>
    /// 创建者ID
    /// </summary>
    public string? CreatedBy { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 预定义的工作流模板
/// </summary>
public static class EmailWorkflowTemplates
{
    public static readonly EmailWorkflow Todo = new()
    {
        AddressPrefix = "todo",
        DisplayName = "待办事项",
        Description = "发送到此邮箱的邮件会自动创建待办事项",
        Icon = "📋",
        IntentType = EmailIntentType.CreateTodo,
        Priority = 10
    };

    public static readonly EmailWorkflow Classify = new()
    {
        AddressPrefix = "classify",
        DisplayName = "邮件分类",
        Description = "自动分析并归类邮件内容，返回分类结果和摘要",
        Icon = "📁",
        IntentType = EmailIntentType.Classify,
        Priority = 20
    };

    public static readonly EmailWorkflow Summary = new()
    {
        AddressPrefix = "summary",
        DisplayName = "内容摘要",
        Description = "提取邮件核心内容，生成简洁摘要",
        Icon = "📝",
        IntentType = EmailIntentType.Summarize,
        Priority = 30
    };

    public static readonly EmailWorkflow Bug = new()
    {
        AddressPrefix = "bug",
        DisplayName = "缺陷报告",
        Description = "自动解析邮件内容创建缺陷工单",
        Icon = "🐛",
        IntentType = EmailIntentType.CreateTodo, // 暂时复用待办，后续可扩展
        TargetAgent = "defect-agent",
        Priority = 40
    };

    public static List<EmailWorkflow> GetDefaults() => new()
    {
        Todo, Classify, Summary
    };
}
