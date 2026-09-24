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

    /// <summary>消息实际发送或产生时绑定的 CDS 会话代；本地消息与尚未确认的出站消息为空。</summary>
    public string? CdsSourceSessionId { get; set; }

    /// <summary>助手回复对应的用户消息 ID，用于跨 CDS 重建保持因果顺序。</summary>
    public string? ReplyToMessageId { get; set; }

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
