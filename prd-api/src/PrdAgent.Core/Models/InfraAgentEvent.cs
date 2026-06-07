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
    public const string Thinking = "thinking";
    public const string ToolCall = "tool_call";
    public const string ToolResult = "tool_result";
    public const string Log = "log";
    public const string Error = "error";
    public const string Done = "done";
    public const string Hook = "hook";
    public const string File = "file";
    public const string Diff = "diff";
    public const string Browser = "browser";
    public const string Manual = "manual";

    public static readonly IReadOnlyList<string> All = new[]
    {
        Status,
        TextDelta,
        Thinking,
        ToolCall,
        ToolResult,
        Log,
        Error,
        Done,
        Hook,
        File,
        Diff,
        Browser,
        Manual
    };

    public static bool IsKnown(string? type) => All.Contains(type ?? string.Empty);
}

public record InfraAgentEventSchemaItem(
    string Type,
    string Description,
    IReadOnlyList<string> RequiredPayloadFields,
    IReadOnlyList<string> OptionalPayloadFields
);

public static class InfraAgentEventSchema
{
    public static readonly IReadOnlyList<InfraAgentEventSchemaItem> Items = new[]
    {
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.Status, "会话状态变化", new[] { "status", "reason" }, Array.Empty<string>()),
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.TextDelta, "Agent 流式文本增量", new[] { "text" }, new[] { "messageId" }),
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.Thinking, "推理模型思考过程增量", new[] { "text" }, new[] { "messageId" }),
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.ToolCall, "工具调用请求或审批状态", new[] { "toolName" }, new[] { "approvalId", "status", "risk", "input" }),
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.ToolResult, "工具执行结果", new[] { "toolName" }, new[] { "status", "output", "exitCode", "stdout", "stderr" }),
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.Log, "运行日志或诊断信息", new[] { "message" }, new[] { "level", "source" }),
        new InfraAgentEventSchemaItem(
            InfraAgentEventTypes.Error,
            "可恢复或终止错误",
            new[] { "message" },
            new[]
            {
                "code",
                "stage",
                "retryable",
                "recoveryKind",
                "nextActions",
                "source",
                "runtimeAdapter",
                "runtimeInstance",
                "content"
            }),
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.Done, "Agent 一轮执行完成", Array.Empty<string>(), new[] { "finalText", "usage" }),
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.Hook, "启动或停止 hook 执行记录", new[] { "stage", "status" }, new[] { "script", "message" }),
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.File, "文件产物或文件读取摘要", new[] { "path" }, new[] { "content", "size", "sha256" }),
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.Diff, "代码 diff 产物", new[] { "diff" }, new[] { "path", "stat" }),
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.Browser, "远程浏览器快照或操作结果", new[] { "url" }, new[] { "title", "dom", "screenshot", "consoleErrors" }),
        new InfraAgentEventSchemaItem(InfraAgentEventTypes.Manual, "人工接管、恢复和人工输入记录", new[] { "action" }, new[] { "reason", "content", "operator" })
    };
}
