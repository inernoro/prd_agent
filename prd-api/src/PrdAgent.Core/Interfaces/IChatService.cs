using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 对话服务接口
/// </summary>
public interface IChatService
{
    /// <summary>发送消息并获取AI响应（流式）</summary>
    IAsyncEnumerable<ChatStreamEvent> SendMessageAsync(
        string sessionId, 
        string content, 
        string? userId = null,
        List<string>? attachmentIds = null,
        CancellationToken cancellationToken = default);
    
    /// <summary>获取对话历史</summary>
    Task<List<Message>> GetHistoryAsync(string sessionId, int limit = 50);
    
    /// <summary>获取群组消息历史</summary>
    Task<List<Message>> GetGroupHistoryAsync(string groupId, int limit = 100);
}

/// <summary>
/// 聊天流式事件
/// </summary>
public class ChatStreamEvent
{
    public string Type { get; set; } = string.Empty; // start, delta, done, error
    public string? MessageId { get; set; }
    public string? Content { get; set; }
    public TokenUsage? TokenUsage { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
    public SenderInfo? Sender { get; set; }
}

/// <summary>
/// 发送者信息
/// </summary>
public class SenderInfo
{
    public string UserId { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public UserRole Role { get; set; }
}
