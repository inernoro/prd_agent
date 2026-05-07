namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Agent 可调工具的元数据 + JSON Schema 描述（喂给 Anthropic SDK 的 tools 参数）。
/// </summary>
public sealed class AgentToolDescriptor
{
    public string Name { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
    /// <summary>JSON Schema string，将被 sidecar 反序列化后透传给 Anthropic API。</summary>
    public string InputSchemaJson { get; init; } = "{\"type\":\"object\"}";
}

/// <summary>工具调用结果。</summary>
public sealed class AgentToolInvokeResult
{
    public bool Success { get; init; }
    public string? Content { get; init; }
    public string? ErrorCode { get; init; }
    public string? Message { get; init; }

    public static AgentToolInvokeResult Ok(string content) =>
        new() { Success = true, Content = content };

    public static AgentToolInvokeResult Fail(string code, string message) =>
        new() { Success = false, ErrorCode = code, Message = message };
}

/// <summary>
/// 在主服务进程内可被 Agent 调用的工具集合。每个工具是一段后端代码（不外暴），
/// 由 sidecar 通过 /api/agent-tools/invoke 反向调用。
///
/// 注册原则：
/// - 工具是只读、幂等、纯逻辑优先（read_*, search_*, get_*）
/// - 写操作工具必须显式登记 scope 并由 controller 单独鉴权
/// - 一个工具一个文件（PrdAgent.Infrastructure/Services/AgentTools/Tools/）
/// </summary>
public interface IAgentToolRegistry
{
    /// <summary>列出全部已注册工具。</summary>
    IReadOnlyList<AgentToolDescriptor> ListAll();

    /// <summary>按白名单过滤，返回可暴露给某次 run 的工具列表。</summary>
    IReadOnlyList<AgentToolDescriptor> Filter(IEnumerable<string>? whitelist);

    /// <summary>调用某个工具。input 是已解析的 JsonElement，由调用方保证。</summary>
    Task<AgentToolInvokeResult> InvokeAsync(
        string toolName,
        System.Text.Json.JsonElement input,
        AgentToolInvocationContext context,
        CancellationToken ct);
}

/// <summary>工具被调用时的上下文（runId / appCallerCode / 调用源 sidecar 名等）。</summary>
public sealed class AgentToolInvocationContext
{
    public string RunId { get; init; } = string.Empty;
    public string? AppCallerCode { get; init; }
    public string? SidecarName { get; init; }
}
