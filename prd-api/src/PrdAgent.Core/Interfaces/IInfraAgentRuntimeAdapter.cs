using System.Text.Json;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Thin runtime boundary for MAP/CDS agent sessions.
/// Implementations should delegate the agent loop to an official SDK where possible;
/// MAP/CDS remains responsible for auth, approval, audit, workspace, and event storage.
/// </summary>
public interface IInfraAgentRuntimeAdapter
{
    string RuntimeKey { get; }

    string AdapterKind { get; }

    bool IsConfigured { get; }

    int InstanceCount { get; }

    int HealthyCount { get; }

    IAsyncEnumerable<InfraAgentRuntimeEvent> RunStreamAsync(
        InfraAgentRuntimeRunRequest request,
        CancellationToken ct);

    Task<InfraAgentRuntimeCancelResult> CancelAsync(string runId, CancellationToken ct);
}

public sealed class InfraAgentRuntimeRunRequest
{
    public string RunId { get; init; } = string.Empty;
    public string Model { get; init; } = "claude-opus-4-5";
    public string SystemPrompt { get; init; } = string.Empty;
    public List<InfraAgentRuntimeMessage> Messages { get; init; } = new();
    public List<InfraAgentRuntimeToolDef> Tools { get; init; } = new();
    public int MaxTokens { get; init; } = 4096;
    public int MaxTurns { get; init; } = 10;
    public int TimeoutSeconds { get; init; } = 600;
    public string? CallbackBaseUrl { get; init; }
    public string? AgentApiKey { get; init; }
    public string? AppCallerCode { get; init; }
    public string? SidecarTag { get; init; }
    public string? StickyKey { get; init; }
    public string? Profile { get; init; }
    public string? BaseUrl { get; init; }
    public string? ApiKey { get; init; }
    public string? Protocol { get; init; }
    public string? RuntimeAdapter { get; init; }
    public string? MapSessionId { get; init; }
    public string? TraceId { get; init; }
    public string? WorkspaceRoot { get; init; }
    public string? GitRepository { get; init; }
    public string? GitRef { get; init; }
}

public sealed class InfraAgentRuntimeMessage
{
    public string Role { get; init; } = "user";
    public string Content { get; init; } = string.Empty;
}

public sealed class InfraAgentRuntimeToolDef
{
    public string Name { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
    public JsonElement InputSchema { get; init; }
}

public enum InfraAgentRuntimeEventType
{
    Unknown = 0,
    TextDelta,
    ToolUse,
    ToolResult,
    Usage,
    RuntimeInit,
    Done,
    Error,
    Keepalive,
}

public sealed class InfraAgentRuntimeEvent
{
    public InfraAgentRuntimeEventType Type { get; init; } = InfraAgentRuntimeEventType.Unknown;
    public string? RawType { get; init; }
    public string? Text { get; init; }
    public string? ToolName { get; init; }
    public string? ToolUseId { get; init; }
    public JsonElement? ToolInput { get; init; }
    public string? Content { get; init; }
    public string? FinalText { get; init; }
    public long? InputTokens { get; init; }
    public long? OutputTokens { get; init; }
    public string? ErrorCode { get; init; }
    public string? Message { get; init; }
    public int? Turn { get; init; }
    public string? RuntimeInstanceName { get; init; }
    public string? Source { get; init; }
}

public sealed record InfraAgentRuntimeCancelResult(
    bool Cancelled,
    string? Reason = null,
    string? AdapterKind = null
);
