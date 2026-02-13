using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Responses;

/// <summary>
/// 群组消息流事件
/// - Type = "message": 完整消息（用户消息 或 AI 完成后的消息）
/// - Type = "delta": AI 流式输出的增量内容
/// - Type = "thinking": AI 思考过程的增量内容
/// - Type = "messageUpdated": 消息更新（如软删除）
/// - Type = "blockEnd": Block 结束事件
/// - Type = "citations": 引用/注脚事件
/// </summary>
public class GroupMessageStreamEventDto
{
    public string Type { get; set; } = "message";
    public GroupMessageStreamMessageDto? Message { get; set; }

    // Delta / Thinking 事件专用字段
    public string? MessageId { get; set; }
    public string? DeltaContent { get; set; }
    public string? ThinkingContent { get; set; }
    public string? BlockId { get; set; }
    public bool IsFirstChunk { get; set; } // 标记是否为首个 chunk（用于隐藏加载动画）
    
    // BlockEnd 事件专用字段
    public string? BlockKind { get; set; }
    public string? BlockLanguage { get; set; }
    
    // Citations 事件专用字段
    public List<DocCitationDto>? Citations { get; set; }
}

public class GroupMessageStreamMessageDto
{
    public string Id { get; set; } = string.Empty;
    public string GroupId { get; set; } = string.Empty;
    public long GroupSeq { get; set; }
    public bool IsDeleted { get; set; }
    public string SessionId { get; set; } = string.Empty;
    public string? RunId { get; set; }
    public string? SenderId { get; set; }
    public string? SenderName { get; set; }
    public UserRole? SenderRole { get; set; }
    public string? SenderAvatarUrl { get; set; }
    public List<GroupMemberTag>? SenderTags { get; set; }
    public MessageRole Role { get; set; }
    public string Content { get; set; } = string.Empty;
    public string? ReplyToMessageId { get; set; }
    public string? ResendOfMessageId { get; set; }
    public UserRole? ViewRole { get; set; }
    public DateTime Timestamp { get; set; }
    public TokenUsage? TokenUsage { get; set; }
}

public class DocCitationDto
{
    public string HeadingTitle { get; set; } = string.Empty;
    public string HeadingId { get; set; } = string.Empty;
    public string Excerpt { get; set; } = string.Empty;
    public double? Score { get; set; }
    public int? Rank { get; set; }
}


