namespace PrdAgent.Core.Interfaces;

/// <summary>
/// LLM客户端接口
/// </summary>
public interface ILLMClient
{
    /// <summary>流式生成回复</summary>
    IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        CancellationToken cancellationToken = default);
    
    /// <summary>流式生成回复（支持 Prompt Caching）</summary>
    IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        bool enablePromptCache,
        CancellationToken cancellationToken = default);
    
    /// <summary>获取服务商名称</summary>
    string Provider { get; }
}

/// <summary>
/// LLM消息
/// </summary>
public class LLMMessage
{
    public string Role { get; set; } = string.Empty; // user, assistant
    public string Content { get; set; } = string.Empty;
    public List<LLMAttachment>? Attachments { get; set; }

    /// <summary>
    /// 标记此消息是否应该被缓存（用于 Claude Prompt Caching）
    /// 设置为 true 时，Claude 会对该消息添加 cache_control: { type: "ephemeral" }
    /// 注意：Claude 最多支持 4 个 cache_control 标记点
    /// </summary>
    public bool ShouldCache { get; set; } = false;
}

/// <summary>
/// LLM附件（用于多模态）
/// </summary>
public class LLMAttachment
{
    public string Type { get; set; } = string.Empty; // image, document
    public string Url { get; set; } = string.Empty;
    public string? MimeType { get; set; }
    public string? Base64Data { get; set; }
}

/// <summary>
/// LLM流式响应块
/// </summary>
public class LLMStreamChunk
{
    public string Type { get; set; } = string.Empty; // start, delta, done, error
    public string? Content { get; set; }
    public int? InputTokens { get; set; }
    public int? OutputTokens { get; set; }
    public int? CacheCreationInputTokens { get; set; }
    public int? CacheReadInputTokens { get; set; }
    public string? ErrorMessage { get; set; }
}
