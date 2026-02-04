using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models.Toolbox;

/// <summary>
/// 意图识别结果
/// </summary>
public class IntentResult
{
    /// <summary>
    /// 主意图：prd_analysis, image_gen, writing, defect, composite
    /// </summary>
    public string PrimaryIntent { get; set; } = string.Empty;

    /// <summary>
    /// 次要意图（当 PrimaryIntent 为 composite 时）
    /// </summary>
    public List<string> SecondaryIntents { get; set; } = new();

    /// <summary>
    /// 从自然语言中提取的实体
    /// </summary>
    public Dictionary<string, object> Entities { get; set; } = new();

    /// <summary>
    /// 置信度 (0.0 - 1.0)
    /// </summary>
    public double Confidence { get; set; }

    /// <summary>
    /// 推理原因
    /// </summary>
    public string? Reasoning { get; set; }

    /// <summary>
    /// 建议的 Agent 列表
    /// </summary>
    public List<string> SuggestedAgents { get; set; } = new();
}

/// <summary>
/// 意图类型常量
/// </summary>
public static class IntentTypes
{
    /// <summary>PRD 分析、需求解读、缺口检测</summary>
    public const string PrdAnalysis = "prd_analysis";

    /// <summary>图片生成、视觉创作、配图</summary>
    public const string ImageGen = "image_gen";

    /// <summary>写作、文章、文案、文学创作</summary>
    public const string Writing = "writing";

    /// <summary>缺陷提交、Bug 报告、问题追踪</summary>
    public const string Defect = "defect";

    /// <summary>需要多个能力组合</summary>
    public const string Composite = "composite";

    /// <summary>通用对话（无法识别具体意图）</summary>
    public const string General = "general";
}

/// <summary>
/// Agent 定义
/// </summary>
public class AgentDefinition
{
    /// <summary>
    /// Agent 标识：prd-agent, visual-agent, literary-agent, defect-agent
    /// </summary>
    public string AgentKey { get; set; } = string.Empty;

    /// <summary>
    /// 显示名称
    /// </summary>
    public string DisplayName { get; set; } = string.Empty;

    /// <summary>
    /// Agent 描述
    /// </summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>
    /// 支持的意图类型
    /// </summary>
    public List<string> SupportedIntents { get; set; } = new();

    /// <summary>
    /// 支持的动作列表
    /// </summary>
    public List<string> SupportedActions { get; set; } = new();
}

/// <summary>
/// Agent 注册表
/// </summary>
public static class AgentRegistry
{
    public static readonly AgentDefinition PrdAgent = new()
    {
        AgentKey = "prd-agent",
        DisplayName = "PRD 分析师",
        Description = "PRD 智能解读与问答，支持需求分析、缺口检测",
        SupportedIntents = new() { IntentTypes.PrdAnalysis },
        SupportedActions = new() { "analyze_prd", "detect_gaps", "answer_question" }
    };

    public static readonly AgentDefinition VisualAgent = new()
    {
        AgentKey = "visual-agent",
        DisplayName = "视觉设计师",
        Description = "高级视觉创作，支持文生图、图生图、多图组合",
        SupportedIntents = new() { IntentTypes.ImageGen },
        SupportedActions = new() { "text2img", "img2img", "compose", "describe_image" }
    };

    public static readonly AgentDefinition LiteraryAgent = new()
    {
        AgentKey = "literary-agent",
        DisplayName = "文学创作者",
        Description = "文学创作与配图，支持写作、润色、生成插图",
        SupportedIntents = new() { IntentTypes.Writing, IntentTypes.ImageGen },
        SupportedActions = new() { "generate_outline", "write_content", "polish", "generate_illustration" }
    };

    public static readonly AgentDefinition DefectAgent = new()
    {
        AgentKey = "defect-agent",
        DisplayName = "缺陷管理员",
        Description = "缺陷提交与跟踪，支持信息提取、分类、审核",
        SupportedIntents = new() { IntentTypes.Defect },
        SupportedActions = new() { "extract_defect", "classify", "generate_report" }
    };

    public static readonly List<AgentDefinition> All = new()
    {
        PrdAgent,
        VisualAgent,
        LiteraryAgent,
        DefectAgent
    };

    /// <summary>
    /// 根据意图获取推荐的 Agent
    /// </summary>
    public static List<AgentDefinition> GetAgentsByIntent(string intent)
    {
        return All.Where(a => a.SupportedIntents.Contains(intent)).ToList();
    }

    /// <summary>
    /// 根据 AgentKey 获取定义
    /// </summary>
    public static AgentDefinition? GetByKey(string agentKey)
    {
        return All.FirstOrDefault(a => a.AgentKey == agentKey);
    }
}

/// <summary>
/// 百宝箱运行记录
/// </summary>
public class ToolboxRun
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = ObjectId.GenerateNewId().ToString();

    /// <summary>
    /// 所属用户 ID
    /// </summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// 会话 ID（可选）
    /// </summary>
    public string? SessionId { get; set; }

    /// <summary>
    /// 用户原始请求
    /// </summary>
    public string UserMessage { get; set; } = string.Empty;

    /// <summary>
    /// 意图识别结果
    /// </summary>
    public IntentResult? Intent { get; set; }

    /// <summary>
    /// 计划执行的 Agent 列表
    /// </summary>
    public List<string> PlannedAgents { get; set; } = new();

    /// <summary>
    /// 执行步骤
    /// </summary>
    public List<ToolboxRunStep> Steps { get; set; } = new();

    /// <summary>
    /// 运行状态
    /// </summary>
    public ToolboxRunStatus Status { get; set; } = ToolboxRunStatus.Pending;

    /// <summary>
    /// 错误信息
    /// </summary>
    public string? ErrorMessage { get; set; }

    /// <summary>
    /// 生成的成果物
    /// </summary>
    public List<ToolboxArtifact> Artifacts { get; set; } = new();

    /// <summary>
    /// 最终响应内容
    /// </summary>
    public string? FinalResponse { get; set; }

    /// <summary>
    /// 最后事件序列号（用于 SSE 断线重连）
    /// </summary>
    public long LastSeq { get; set; }

    /// <summary>
    /// 创建时间
    /// </summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 开始执行时间
    /// </summary>
    public DateTime? StartedAt { get; set; }

    /// <summary>
    /// 完成时间
    /// </summary>
    public DateTime? CompletedAt { get; set; }
}

/// <summary>
/// 运行状态
/// </summary>
public enum ToolboxRunStatus
{
    /// <summary>等待中</summary>
    Pending,
    /// <summary>识别意图中</summary>
    Analyzing,
    /// <summary>执行中</summary>
    Running,
    /// <summary>已完成</summary>
    Completed,
    /// <summary>失败</summary>
    Failed,
    /// <summary>已取消</summary>
    Cancelled
}

/// <summary>
/// 执行步骤
/// </summary>
public class ToolboxRunStep
{
    /// <summary>
    /// 步骤 ID
    /// </summary>
    public string StepId { get; set; } = Guid.NewGuid().ToString("N")[..8];

    /// <summary>
    /// 步骤序号
    /// </summary>
    public int Index { get; set; }

    /// <summary>
    /// Agent 标识
    /// </summary>
    public string AgentKey { get; set; } = string.Empty;

    /// <summary>
    /// Agent 显示名称
    /// </summary>
    public string AgentDisplayName { get; set; } = string.Empty;

    /// <summary>
    /// 执行的动作
    /// </summary>
    public string Action { get; set; } = string.Empty;

    /// <summary>
    /// 输入参数
    /// </summary>
    public Dictionary<string, object> Input { get; set; } = new();

    /// <summary>
    /// 步骤状态
    /// </summary>
    public ToolboxStepStatus Status { get; set; } = ToolboxStepStatus.Pending;

    /// <summary>
    /// 输出内容
    /// </summary>
    public string? Output { get; set; }

    /// <summary>
    /// 生成的成果物 ID
    /// </summary>
    public List<string> ArtifactIds { get; set; } = new();

    /// <summary>
    /// 错误信息
    /// </summary>
    public string? ErrorMessage { get; set; }

    /// <summary>
    /// 开始时间
    /// </summary>
    public DateTime? StartedAt { get; set; }

    /// <summary>
    /// 完成时间
    /// </summary>
    public DateTime? CompletedAt { get; set; }
}

/// <summary>
/// 步骤状态
/// </summary>
public enum ToolboxStepStatus
{
    Pending,
    Running,
    Completed,
    Failed,
    Skipped
}

/// <summary>
/// 成果物
/// </summary>
public class ToolboxArtifact
{
    /// <summary>
    /// 成果物 ID
    /// </summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 成果物类型
    /// </summary>
    public ToolboxArtifactType Type { get; set; }

    /// <summary>
    /// 名称
    /// </summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// MIME 类型
    /// </summary>
    public string MimeType { get; set; } = "text/plain";

    /// <summary>
    /// 内容（文本类型直接存储）
    /// </summary>
    public string? Content { get; set; }

    /// <summary>
    /// 存储 URL（文件类型）
    /// </summary>
    public string? Url { get; set; }

    /// <summary>
    /// 来源步骤 ID
    /// </summary>
    public string? SourceStepId { get; set; }

    /// <summary>
    /// 创建时间
    /// </summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 成果物类型
/// </summary>
public enum ToolboxArtifactType
{
    Markdown,
    Html,
    Image,
    Code,
    Json,
    Text
}
