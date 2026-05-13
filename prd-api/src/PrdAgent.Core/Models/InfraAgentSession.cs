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

    public string Runtime { get; set; } = InfraAgentRuntimes.ClaudeSdk;

    public string? Model { get; set; }

    public string Title { get; set; } = string.Empty;

    public string Status { get; set; } = InfraAgentSessionStatuses.Idle;

    public string? LastError { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? StartedAt { get; set; }

    public DateTime? StoppedAt { get; set; }
}

public static class InfraAgentRuntimes
{
    public const string ClaudeSdk = "claude-sdk";
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
