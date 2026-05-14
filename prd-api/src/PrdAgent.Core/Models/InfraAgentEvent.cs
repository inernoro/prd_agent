namespace PrdAgent.Core.Models;

/// <summary>
/// MAP 基础设施 Agent 会话事件。
/// </summary>
public class InfraAgentEvent
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string SessionId { get; set; } = string.Empty;

    public long Seq { get; set; }

    public string TraceId { get; set; } = string.Empty;

    public string Type { get; set; } = InfraAgentEventTypes.Status;

    public string PayloadJson { get; set; } = "{}";

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public static class InfraAgentEventTypes
{
    public const string Status = "status";
    public const string TextDelta = "text_delta";
    public const string ToolCall = "tool_call";
    public const string ToolResult = "tool_result";
    public const string Log = "log";
    public const string Error = "error";
    public const string Done = "done";
    public const string Hook = "hook";
}
