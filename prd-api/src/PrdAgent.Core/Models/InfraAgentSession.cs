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

    public string ToolPolicy { get; set; } = InfraAgentToolPolicies.ConfirmDangerous;

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

public static class InfraAgentToolPolicies
{
    public const string ReadonlyAuto = "readonly-auto";
    public const string AutoAllowReadonly = "auto-allow-readonly";
    public const string ConfirmDangerous = "confirm-dangerous";
    public const string CodeWritableConfirm = "code-writable-confirm";
    public const string ManualAll = "manual-all";
    public const string DenyAll = "deny-all";

    public static string Normalize(string? policy)
    {
        var normalized = string.IsNullOrWhiteSpace(policy)
            ? null
            : policy.Trim().ToLowerInvariant();

        return normalized switch
        {
            ReadonlyAuto or AutoAllowReadonly or ConfirmDangerous or CodeWritableConfirm or ManualAll or DenyAll
                => normalized,
            _ => ConfirmDangerous
        };
    }

    public static bool ShouldExposeToolToRuntime(string? policy, string toolName)
    {
        var normalized = Normalize(policy);
        if (normalized == DenyAll) return false;

        if (normalized is ReadonlyAuto or AutoAllowReadonly)
        {
            return IsReadonlyTool(toolName);
        }

        if (normalized == CodeWritableConfirm)
        {
            return IsReadonlyTool(toolName) || IsCodeWritableTool(toolName);
        }

        if (IsCodeWritableTool(toolName))
        {
            return false;
        }

        return normalized is ConfirmDangerous or ManualAll;
    }

    public static bool AllowsToolInvocation(string? policy, string toolName)
    {
        var normalized = Normalize(policy);
        if (normalized == DenyAll) return false;
        if (IsReadonlyTool(toolName)) return true;
        if (IsCodeWritableTool(toolName)) return normalized == CodeWritableConfirm;
        return normalized is ConfirmDangerous or ManualAll;
    }

    public static bool IsReadonlyTool(string toolName) => toolName.Trim().ToLowerInvariant() switch
    {
        "echo" or
        "current_time" or
        "repo_list_files" or
        "repo_read_file" or
        "repo_search" or
        "repo_git_status" or
        "repo_git_diff" or
        "kb_list" or
        "kb_search" or
        "kb_read" or
        "kb_diff" or
        "cds_bridge_snapshot" => true,
        _ => false
    };

    public static bool IsCodeWritableTool(string toolName) => toolName.Trim().ToLowerInvariant() switch
    {
        "repo_write_file" or
        "repo_run_command" or
        "repo_create_pull_request" or
        "bash" or
        "edit" or
        "write" => true,
        _ => false
    };
}
