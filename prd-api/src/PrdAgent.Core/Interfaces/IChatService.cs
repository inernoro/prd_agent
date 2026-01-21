using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 对话服务接口
/// </summary>
public interface IChatService
{
    /// <summary>发送消息并获取AI响应（流式）</summary>
    /// <param name="disableGroupContext">
    /// 禁用群上下文：true 时仅使用系统提示词+PRD+当前用户消息，不拼接历史对话。
    /// 用于开放平台 API 等场景，避免多轮对话干扰。默认 false（保留历史上下文）。
    /// </param>
    /// <param name="systemPromptOverride">
    /// 系统提示词覆盖：非空时用该值完全替换默认系统提示词。
    /// 用于开放平台对话场景，使用对话风格的系统提示词。默认 null（使用默认提示词）。
    /// </param>
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
        bool disableGroupContext = false,
        string? systemPromptOverride = null,
        UserRole? answerAsRole = null,
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

    /// <summary>
    /// 是否跳过了 AI 回复（普通群聊模式）
    /// </summary>
    public bool? SkippedAiReply { get; set; }
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
