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
        string? resendOfMessageId = null,
        string? promptKey = null,
        string? userId = null,
        List<string>? attachmentIds = null,
        string? runId = null,
        string? fixedUserMessageId = null,
        string? fixedAssistantMessageId = null,
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

    /// <summary>
    /// 服务端时间点（UTC）：用于端到端对齐与首字延迟（TTFT）计算，避免前端本地时间误导。
    /// </summary>
    public DateTime? RequestReceivedAtUtc { get; set; }
    public DateTime? StartAtUtc { get; set; }
    public DateTime? FirstTokenAtUtc { get; set; }
    public DateTime? DoneAtUtc { get; set; }
    public int? TtftMs { get; set; }

    // Block Protocol（用于稳定的流式 Markdown 渲染）
    // type: blockStart / blockDelta / blockEnd
    public string? BlockId { get; set; }
    public string? BlockKind { get; set; } // paragraph | heading | listItem | codeBlock
    public string? BlockLanguage { get; set; } // codeBlock 可选语言

    /// <summary>
    /// 结构化引用（type=citations 时下发；也可附带在 done 前后事件里）
    /// </summary>
    public List<DocCitation>? Citations { get; set; }
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
