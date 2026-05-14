namespace PrdAgent.Core.Models;

/// <summary>
/// MAP 基础设施 Agent 会话 Hook 配置。
/// </summary>
public class InfraAgentHookProfile
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string UserId { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string? BeforeStart { get; set; }

    public string? AfterStart { get; set; }

    public string? BeforeStop { get; set; }

    public string? AfterStop { get; set; }

    public string FailurePolicy { get; set; } = InfraAgentHookFailurePolicies.BlockStart;

    public int TimeoutSeconds { get; set; } = 30;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public static class InfraAgentHookFailurePolicies
{
    public const string BlockStart = "block-start";
    public const string Continue = "continue";
}
