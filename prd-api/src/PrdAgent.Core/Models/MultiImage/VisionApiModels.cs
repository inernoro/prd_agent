using System.Text.Json.Serialization;

namespace PrdAgent.Core.Models.MultiImage;

/// <summary>
/// Vision API 请求体（用于 /v1/chat/completions）
/// 支持多图输入，适用于 nanobanana 等支持 Vision 的模型
/// </summary>
public class VisionRequest
{
    [JsonPropertyName("model")]
    public string Model { get; set; } = string.Empty;

    [JsonPropertyName("messages")]
    public List<VisionMessage> Messages { get; set; } = new();

    [JsonPropertyName("max_tokens")]
    public int MaxTokens { get; set; } = 4096;

    /// <summary>
    /// 可选：温度参数（0-2）
    /// </summary>
    [JsonPropertyName("temperature")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? Temperature { get; set; }
}

/// <summary>
/// Vision API 消息
/// </summary>
public class VisionMessage
{
    [JsonPropertyName("role")]
    public string Role { get; set; } = "user";

    [JsonPropertyName("content")]
    public List<VisionContentItem> Content { get; set; } = new();
}

/// <summary>
/// Vision API 内容项（text 或 image_url）
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]
[JsonDerivedType(typeof(VisionTextContent), "text")]
[JsonDerivedType(typeof(VisionImageContent), "image_url")]
public abstract class VisionContentItem
{
    [JsonPropertyName("type")]
    public abstract string Type { get; }
}

/// <summary>
/// 文本内容项
/// </summary>
public class VisionTextContent : VisionContentItem
{
    [JsonPropertyName("type")]
    public override string Type => "text";

    [JsonPropertyName("text")]
    public string Text { get; set; } = string.Empty;
}

/// <summary>
/// 图片内容项
/// </summary>
public class VisionImageContent : VisionContentItem
{
    [JsonPropertyName("type")]
    public override string Type => "image_url";

    [JsonPropertyName("image_url")]
    public VisionImageUrl ImageUrl { get; set; } = new();
}

/// <summary>
/// 图片 URL 对象
/// </summary>
public class VisionImageUrl
{
    /// <summary>
    /// 图片 URL（支持 data:mime;base64,... 格式）
    /// </summary>
    [JsonPropertyName("url")]
    public string Url { get; set; } = string.Empty;

    /// <summary>
    /// 可选：图片详细程度（auto/low/high）
    /// </summary>
    [JsonPropertyName("detail")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Detail { get; set; }
}

/// <summary>
/// Vision API 响应
/// </summary>
public class VisionResponse
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("object")]
    public string Object { get; set; } = string.Empty;

    [JsonPropertyName("created")]
    public long Created { get; set; }

    [JsonPropertyName("model")]
    public string Model { get; set; } = string.Empty;

    [JsonPropertyName("choices")]
    public List<VisionChoice> Choices { get; set; } = new();

    [JsonPropertyName("usage")]
    public VisionUsage? Usage { get; set; }
}

/// <summary>
/// Vision API 选择项
/// </summary>
public class VisionChoice
{
    [JsonPropertyName("index")]
    public int Index { get; set; }

    [JsonPropertyName("message")]
    public VisionResponseMessage? Message { get; set; }

    [JsonPropertyName("finish_reason")]
    public string? FinishReason { get; set; }
}

/// <summary>
/// Vision API 响应消息
/// </summary>
public class VisionResponseMessage
{
    [JsonPropertyName("role")]
    public string Role { get; set; } = string.Empty;

    /// <summary>
    /// 响应内容（对于图片生成模型，可能是 base64 图片数据）
    /// </summary>
    [JsonPropertyName("content")]
    public string? Content { get; set; }
}

/// <summary>
/// Vision API Token 使用统计
/// </summary>
public class VisionUsage
{
    [JsonPropertyName("prompt_tokens")]
    public int PromptTokens { get; set; }

    [JsonPropertyName("completion_tokens")]
    public int CompletionTokens { get; set; }

    [JsonPropertyName("total_tokens")]
    public int TotalTokens { get; set; }
}

/// <summary>
/// 已加载的图片引用数据（用于传递给 Vision API）
/// </summary>
public class ImageRefData
{
    /// <summary>
    /// 引用 ID（@imgN 中的 N）
    /// </summary>
    public int RefId { get; set; }

    /// <summary>
    /// 图片 Base64（完整格式：data:mime;base64,...）
    /// </summary>
    public string Base64 { get; set; } = string.Empty;

    /// <summary>
    /// MIME 类型（如 image/jpeg, image/png）
    /// </summary>
    public string MimeType { get; set; } = "image/png";

    /// <summary>
    /// 用户标签（如"风格参考图"）
    /// </summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>
    /// 可选：图片角色
    /// </summary>
    public string? Role { get; set; }
}
