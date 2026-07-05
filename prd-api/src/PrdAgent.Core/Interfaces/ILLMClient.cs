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

    /// <summary>
    /// 视觉细节档位（对应 OpenAI 多模态 image_url.detail："high" / "low" / "auto"）。
    /// null 时 Gateway 默认按 "high" 发送——避免识图被上游默认 "auto" 降级到低保真
    /// （小目标/远处文字识别不准的根因）。帧抽取等大批量低保真场景可显式传 "low"。
    /// </summary>
    public string? Detail { get; set; }
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
