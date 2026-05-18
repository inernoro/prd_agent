namespace PrdAgent.Core.Models;

/// <summary>
/// MAP 基础设施 Agent 会话。
/// 一条会话绑定一个 CDS 连接，后续阶段再绑定 CDS 运行实例。
/// </summary>
public class InfraAgentSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string UserId { get; set; } = string.Empty;

    public string ConnectionId { get; set; } = string.Empty;

    public string Partner { get; set; } = "cds";

    public string CdsProjectId { get; set; } = string.Empty;

    public string? CdsSessionId { get; set; }

    public string? CdsWorkerId { get; set; }

    public string? CdsContainerName { get; set; }

    public string TraceId { get; set; } = string.Empty;

    public string? RuntimeProfileId { get; set; }

    public string? ModelBaseUrl { get; set; }

    public string? WorkspaceRoot { get; set; }

    public string? GitRepository { get; set; }

    public string? GitRef { get; set; }

    public string Runtime { get; set; } = InfraAgentRuntimes.ClaudeSdk;

    public string? RuntimeAdapter { get; set; }

    public string? CurrentRuntimeRunId { get; set; }

    public string? Model { get; set; }

    public double ResourceCpuCores { get; set; } = 2;

    public int ResourceMemoryMb { get; set; } = 4096;

    public int TimeoutSeconds { get; set; } = 900;

    public string NetworkPolicy { get; set; } = InfraAgentRuntimeNetworkPolicies.Restricted;

    public int AutoCleanupMinutes { get; set; } = 30;

    public string ToolPolicy { get; set; } = "confirm-dangerous";

    public string? HookProfileId { get; set; }

    public string Title { get; set; } = string.Empty;

    public string Status { get; set; } = InfraAgentSessionStatuses.Idle;

    public bool IsArchived { get; set; }

    public bool ManualTakeoverEnabled { get; set; }

    public DateTime? ManualTakeoverAt { get; set; }

    public string? ManualTakeoverReason { get; set; }

    public string? LastError { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? StartedAt { get; set; }

    public DateTime? StoppedAt { get; set; }
}

public static class InfraAgentRuntimes
{
    public const string ClaudeSdk = "claude-sdk";
    public const string OpenAiCompatible = "openai-compatible";
    public const string Codex = "codex";
    public const string Custom = "custom";
}

public static class InfraAgentSessionStatuses
{
    public const string Creating = "creating";
    public const string Running = "running";
    public const string Idle = "idle";
    public const string Stopping = "stopping";
    public const string Stopped = "stopped";
    public const string Failed = "failed";
}
