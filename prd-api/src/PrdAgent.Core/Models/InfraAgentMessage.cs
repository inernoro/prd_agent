namespace PrdAgent.Core.Models;

/// <summary>
/// MAP 基础设施 Agent 会话消息。
/// </summary>
public class InfraAgentMessage
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string SessionId { get; set; } = string.Empty;

    public string Role { get; set; } = InfraAgentMessageRoles.User;

    public string Content { get; set; } = string.Empty;

    public string Status { get; set; } = InfraAgentMessageStatuses.Completed;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public static class InfraAgentMessageRoles
{
    public const string User = "user";
    public const string Assistant = "assistant";
    public const string System = "system";
    public const string Tool = "tool";
}

public static class InfraAgentMessageStatuses
{
    public const string Streaming = "streaming";
    public const string Completed = "completed";
    public const string Failed = "failed";
}
