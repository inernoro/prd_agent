namespace PrdAgent.Core.Models;

/// <summary>
/// 消息实体
/// </summary>
public class Message
{
    /// <summary>消息唯一标识（通过 IIdGenerator 生成）</summary>
    public string Id { get; set; } = string.Empty;
    
    /// <summary>所属群组ID</summary>
    public string GroupId { get; set; } = string.Empty;

    /// <summary>
    /// 群内顺序号（单调递增，仅群消息使用；用于 SSE 断线续传与严格有序回放）。
    /// - 非群消息/历史消息可为空
    /// </summary>
    public long? GroupSeq { get; set; }

    /// <summary>
    /// 是否已软删除（用户态不可见；后台/日志仍可用于排障与追溯）。
    /// </summary>
    public bool IsDeleted { get; set; } = false;

    /// <summary>删除时间（UTC）</summary>
    public DateTime? DeletedAtUtc { get; set; }

    /// <summary>删除人用户ID（软删除时记录；AI 消息可能为空）</summary>
    public string? DeletedByUserId { get; set; }

    /// <summary>删除原因（可选：例如 resend/user_delete 等）</summary>
    public string? DeleteReason { get; set; }
    
    /// <summary>会话ID</summary>
    public string SessionId { get; set; } = string.Empty;

    /// <summary>
    /// 运行ID（预埋：未来用于多 Agent 编排/自动交接/回放）。
    /// - 当前版本可为空，不影响现有消息逻辑
    /// </summary>
    public string? RunId { get; set; }
    
    /// <summary>发送者用户ID（User 和 Assistant 消息统一使用此字段）</summary>
    public string? SenderId { get; set; }
    
    /// <summary>消息角色</summary>
    public MessageRole Role { get; set; } = MessageRole.User;
    
    /// <summary>消息内容</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>
    /// AI 思考过程（DeepSeek reasoning_content 等），与正文分开存储。
    /// 仅 Assistant 消息使用；前端在正文输出前展示，正文开始后自动折叠。
    /// </summary>
    public string? ThinkingContent { get; set; }

    /// <summary>
    /// Assistant 消息所回答的 User 消息 ID（用于“一问多答”与排障关联）。
    /// </summary>
    public string? ReplyToMessageId { get; set; }

    /// <summary>
    /// 新 User 消息“重发自”的旧 User 消息 ID（仅用于排障/溯源；用户态不展示）。
    /// </summary>
    public string? ResendOfMessageId { get; set; }
    
    /// <summary>
    /// 关联的 LLM 请求 requestId（用于后台定位本次调用日志；可为空，兼容历史消息/非LLM消息）
    /// </summary>
    public string? LlmRequestId { get; set; }

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
