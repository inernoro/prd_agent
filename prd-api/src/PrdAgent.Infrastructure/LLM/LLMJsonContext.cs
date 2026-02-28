using System.Text.Json.Serialization;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// LLM 客户端 AOT 兼容的 JSON 序列化上下文
/// </summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
// Claude API
[JsonSerializable(typeof(ClaudeRequest))]
[JsonSerializable(typeof(ClaudeCachedRequest))]
[JsonSerializable(typeof(ClaudeStreamEvent))]
[JsonSerializable(typeof(ClaudeMessage))]
[JsonSerializable(typeof(ClaudeDelta))]
[JsonSerializable(typeof(ClaudeUsage))]
[JsonSerializable(typeof(ClaudeCacheControl))]
[JsonSerializable(typeof(ClaudeSystemBlock))]
[JsonSerializable(typeof(List<ClaudeSystemBlock>))]
// OpenAI API
[JsonSerializable(typeof(OpenAIRequest))]
[JsonSerializable(typeof(OpenAIStreamEvent))]
[JsonSerializable(typeof(OpenAIChoice))]
[JsonSerializable(typeof(OpenAIDelta))]
[JsonSerializable(typeof(OpenAIUsage))]
[JsonSerializable(typeof(OpenAIPromptTokensDetails))]
// OpenAI Vision 多模态内容类型
[JsonSerializable(typeof(OpenAIRequestMessage))]
[JsonSerializable(typeof(OpenAITextContent))]
[JsonSerializable(typeof(OpenAIImageUrlContent))]
[JsonSerializable(typeof(OpenAIImageUrl))]
[JsonSerializable(typeof(List<object>))]
internal partial class LLMJsonContext : JsonSerializerContext
{
}

#region Claude API Models

/// <summary>
/// Claude API 请求（普通模式）
/// </summary>
internal class ClaudeRequest
{
    public string Model { get; set; } = string.Empty;
    public int MaxTokens { get; set; }
    public double Temperature { get; set; }
    public string System { get; set; } = string.Empty;
    public List<ClaudeRequestMessage> Messages { get; set; } = new();
    public bool Stream { get; set; }
}

/// <summary>
/// Claude API 请求（带 Prompt Caching）
/// </summary>
internal class ClaudeCachedRequest
{
    public string Model { get; set; } = string.Empty;
    public int MaxTokens { get; set; }
    public double Temperature { get; set; }
    public List<ClaudeSystemBlock> System { get; set; } = new();
    public List<ClaudeRequestMessage> Messages { get; set; } = new();
    public bool Stream { get; set; }
}

/// <summary>
/// Claude System Block（支持 cache_control）
/// </summary>
internal class ClaudeSystemBlock
{
    public string Type { get; set; } = "text";
    public string Text { get; set; } = string.Empty;
    public ClaudeCacheControl? CacheControl { get; set; }
}

/// <summary>
/// Claude Cache Control
/// </summary>
internal class ClaudeCacheControl
{
    public string Type { get; set; } = "ephemeral";
}

/// <summary>
/// Claude 请求消息
/// </summary>
internal class ClaudeRequestMessage
{
    public string Role { get; set; } = string.Empty;
    public object Content { get; set; } = string.Empty;
}

/// <summary>
/// Claude 文本内容
/// </summary>
internal class ClaudeTextContent
{
    public string Type { get; set; } = "text";
    public string Text { get; set; } = string.Empty;
}

/// <summary>
/// Claude 图片内容
/// </summary>
internal class ClaudeImageContent
{
    public string Type { get; set; } = "image";
    public ClaudeImageSource Source { get; set; } = new();
}

/// <summary>
/// Claude 图片源
/// </summary>
internal class ClaudeImageSource
{
    public string Type { get; set; } = "base64";
    public string MediaType { get; set; } = string.Empty;
    public string Data { get; set; } = string.Empty;
}

/// <summary>
/// Claude 流式事件
/// </summary>
internal class ClaudeStreamEvent
{
    public string? Type { get; set; }
    public ClaudeMessage? Message { get; set; }
    public ClaudeDelta? Delta { get; set; }
    public ClaudeUsage? Usage { get; set; }
}

/// <summary>
/// Claude 消息
/// </summary>
internal class ClaudeMessage
{
    public ClaudeUsage? Usage { get; set; }
}

/// <summary>
/// Claude Delta
/// </summary>
internal class ClaudeDelta
{
    public string? Text { get; set; }
}

/// <summary>
/// Claude 使用量
/// </summary>
internal class ClaudeUsage
{
    public int InputTokens { get; set; }
    public int OutputTokens { get; set; }
    public int CacheCreationInputTokens { get; set; }
    public int CacheReadInputTokens { get; set; }
}

#endregion

#region OpenAI API Models

/// <summary>
/// OpenAI API 请求
/// </summary>
internal class OpenAIRequest
{
    public string Model { get; set; } = string.Empty;
    public int MaxTokens { get; set; }
    public double Temperature { get; set; }
    public List<OpenAIRequestMessage> Messages { get; set; } = new();
    public bool Stream { get; set; }
    public OpenAIStreamOptions? StreamOptions { get; set; }
}

/// <summary>
/// OpenAI 流选项
/// </summary>
internal class OpenAIStreamOptions
{
    public bool IncludeUsage { get; set; }
}

/// <summary>
/// OpenAI 请求消息
/// </summary>
internal class OpenAIRequestMessage
{
    public string Role { get; set; } = string.Empty;
    public object Content { get; set; } = string.Empty;
}

/// <summary>
/// OpenAI 文本内容
/// </summary>
internal class OpenAITextContent
{
    public string Type { get; set; } = "text";
    public string Text { get; set; } = string.Empty;
}

/// <summary>
/// OpenAI 图片URL内容
/// </summary>
internal class OpenAIImageUrlContent
{
    public string Type { get; set; } = "image_url";
    public OpenAIImageUrl ImageUrl { get; set; } = new();
}

/// <summary>
/// OpenAI 图片URL
/// </summary>
internal class OpenAIImageUrl
{
    public string Url { get; set; } = string.Empty;
}

/// <summary>
/// OpenAI 流式事件
/// </summary>
internal class OpenAIStreamEvent
{
    public OpenAIChoice[]? Choices { get; set; }
    public OpenAIUsage? Usage { get; set; }
}

/// <summary>
/// OpenAI 选择
/// </summary>
internal class OpenAIChoice
{
    public OpenAIDelta? Delta { get; set; }
}

/// <summary>
/// OpenAI Delta
/// </summary>
internal class OpenAIDelta
{
    public string? Content { get; set; }
    public string? ReasoningContent { get; set; }
}

/// <summary>
/// OpenAI 使用量
/// </summary>
internal class OpenAIUsage
{
    public int PromptTokens { get; set; }
    public int CompletionTokens { get; set; }
    public int? TotalTokens { get; set; }
    public OpenAIPromptTokensDetails? PromptTokensDetails { get; set; }
}

/// <summary>
/// OpenAI prompt_tokens_details（部分平台会返回 cached_tokens）
/// </summary>
internal class OpenAIPromptTokensDetails
{
    public int? CachedTokens { get; set; }
}

#endregion

