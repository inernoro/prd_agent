using PrdAgent.Core.Models.Toolbox;

namespace PrdAgent.Api.Services.Toolbox;

/// <summary>
/// Agent 适配器接口
/// 所有 Agent 通过此接口被统一调度
/// </summary>
public interface IAgentAdapter
{
    /// <summary>
    /// Agent 标识
    /// </summary>
    string AgentKey { get; }

    /// <summary>
    /// Agent 显示名称
    /// </summary>
    string DisplayName { get; }

    /// <summary>
    /// 检查是否能处理指定动作
    /// </summary>
    bool CanHandle(string action);

    /// <summary>
    /// 执行 Agent 动作（非流式）
    /// </summary>
    Task<AgentExecutionResult> ExecuteAsync(
        AgentExecutionContext context,
        CancellationToken ct = default);

    /// <summary>
    /// 执行 Agent 动作（流式）
    /// </summary>
    IAsyncEnumerable<AgentStreamChunk> StreamExecuteAsync(
        AgentExecutionContext context,
        CancellationToken ct = default);
}

/// <summary>
/// Agent 执行上下文
/// </summary>
public class AgentExecutionContext
{
    /// <summary>
    /// Run ID
    /// </summary>
    public string RunId { get; set; } = string.Empty;

    /// <summary>
    /// 步骤 ID
    /// </summary>
    public string StepId { get; set; } = string.Empty;

    /// <summary>
    /// 用户 ID
    /// </summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// 用户原始消息
    /// </summary>
    public string UserMessage { get; set; } = string.Empty;

    /// <summary>
    /// 要执行的动作
    /// </summary>
    public string Action { get; set; } = string.Empty;

    /// <summary>
    /// 输入参数
    /// </summary>
    public Dictionary<string, object> Input { get; set; } = new();

    /// <summary>
    /// 意图识别结果
    /// </summary>
    public IntentResult? Intent { get; set; }

    /// <summary>
    /// 前序步骤的输出（用于串行编排）
    /// </summary>
    public Dictionary<string, string> PreviousOutputs { get; set; } = new();

    /// <summary>
    /// 获取前序步骤的输出
    /// </summary>
    public string? GetPreviousOutput(string stepId)
    {
        return PreviousOutputs.TryGetValue(stepId, out var output) ? output : null;
    }

    /// <summary>
    /// 获取最近一个前序步骤的输出
    /// </summary>
    public string? GetLastOutput()
    {
        return PreviousOutputs.Values.LastOrDefault();
    }
}

/// <summary>
/// Agent 执行结果
/// </summary>
public class AgentExecutionResult
{
    /// <summary>
    /// 是否成功
    /// </summary>
    public bool Success { get; set; }

    /// <summary>
    /// 输出内容
    /// </summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>
    /// 生成的成果物
    /// </summary>
    public List<ToolboxArtifact> Artifacts { get; set; } = new();

    /// <summary>
    /// 错误信息
    /// </summary>
    public string? ErrorMessage { get; set; }

    /// <summary>
    /// 元数据
    /// </summary>
    public Dictionary<string, object> Metadata { get; set; } = new();

    public static AgentExecutionResult Ok(string content, List<ToolboxArtifact>? artifacts = null)
    {
        return new AgentExecutionResult
        {
            Success = true,
            Content = content,
            Artifacts = artifacts ?? new()
        };
    }

    public static AgentExecutionResult Fail(string errorMessage)
    {
        return new AgentExecutionResult
        {
            Success = false,
            ErrorMessage = errorMessage
        };
    }
}

/// <summary>
/// Agent 流式输出块
/// </summary>
public class AgentStreamChunk
{
    /// <summary>
    /// 块类型
    /// </summary>
    public AgentChunkType Type { get; set; }

    /// <summary>
    /// 内容（文本增量）
    /// </summary>
    public string? Content { get; set; }

    /// <summary>
    /// 成果物（当 Type=Artifact 时）
    /// </summary>
    public ToolboxArtifact? Artifact { get; set; }

    /// <summary>
    /// 元数据
    /// </summary>
    public Dictionary<string, object>? Metadata { get; set; }

    public static AgentStreamChunk Text(string content) => new()
    {
        Type = AgentChunkType.Text,
        Content = content
    };

    public static AgentStreamChunk ArtifactChunk(ToolboxArtifact artifact) => new()
    {
        Type = AgentChunkType.Artifact,
        Artifact = artifact
    };

    public static AgentStreamChunk Done(string? finalContent = null) => new()
    {
        Type = AgentChunkType.Done,
        Content = finalContent
    };

    public static AgentStreamChunk Error(string message) => new()
    {
        Type = AgentChunkType.Error,
        Content = message
    };
}

/// <summary>
/// 块类型
/// </summary>
public enum AgentChunkType
{
    Text,
    Artifact,
    Done,
    Error
}
