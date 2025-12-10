namespace PrdAgent.Core.Models;

/// <summary>
/// 消息实体
/// </summary>
public class Message
{
    /// <summary>消息唯一标识</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString();
    
    /// <summary>所属群组ID</summary>
    public string GroupId { get; set; } = string.Empty;
    
    /// <summary>会话ID</summary>
    public string SessionId { get; set; } = string.Empty;
    
    /// <summary>发送者用户ID（AI消息为null）</summary>
    public string? SenderId { get; set; }
    
    /// <summary>消息角色</summary>
    public MessageRole Role { get; set; } = MessageRole.User;
    
    /// <summary>消息内容</summary>
    public string Content { get; set; } = string.Empty;
    
    /// <summary>回答时的视角角色</summary>
    public UserRole? ViewRole { get; set; }
    
    /// <summary>关联的附件ID列表</summary>
    public List<string> AttachmentIds { get; set; } = new();
    
    /// <summary>Token使用量</summary>
    public TokenUsage? TokenUsage { get; set; }
    
    /// <summary>消息时间</summary>
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// Token使用量
/// </summary>
public class TokenUsage
{
    /// <summary>输入Token数</summary>
    public int Input { get; set; }
    
    /// <summary>输出Token数</summary>
    public int Output { get; set; }
}


