using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Responses;

public class GroupMessageStreamEventDto
{
    public string Type { get; set; } = "message";
    public GroupMessageStreamMessageDto Message { get; set; } = new();
}

public class GroupMessageStreamMessageDto
{
    public string Id { get; set; } = string.Empty;
    public string GroupId { get; set; } = string.Empty;
    public long GroupSeq { get; set; }
    public string SessionId { get; set; } = string.Empty;
    public string? SenderId { get; set; }
    public MessageRole Role { get; set; }
    public string Content { get; set; } = string.Empty;
    public UserRole? ViewRole { get; set; }
    public DateTime Timestamp { get; set; }
    public TokenUsage? TokenUsage { get; set; }
}


