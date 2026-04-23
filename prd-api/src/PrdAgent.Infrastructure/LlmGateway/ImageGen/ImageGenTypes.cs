namespace PrdAgent.Infrastructure.LlmGateway.ImageGen;

/// <summary>
/// 图片生成请求 payload（业务无关，只有生成参数）
/// </summary>
public sealed class ImageGenPayload
{
    public required string Prompt { get; init; }
    public int N { get; init; } = 1;
    public string? Size { get; init; }
    public string? ResponseFormat { get; init; }           // "url" | "b64_json"
    /// <summary>参考图（Base64 data URI 列表，null 或空=文生图）</summary>
    public IReadOnlyList<string>? Images { get; init; }
    public string? MaskBase64 { get; init; }               // 蒙版（图生图）
}

/// <summary>
/// 图片生成网关结果
/// </summary>
public sealed class ImageGenGatewayResult
{
    public bool Success { get; init; }
    public string? ErrorCode { get; init; }
    public string? ErrorMessage { get; init; }
    public int StatusCode { get; init; }
    public IReadOnlyList<ImageGenOutputItem> Images { get; init; } = [];
    public long DurationMs { get; init; }

    public static ImageGenGatewayResult Fail(string errorCode, string errorMessage, int statusCode = 500)
        => new() { Success = false, ErrorCode = errorCode, ErrorMessage = errorMessage, StatusCode = statusCode };
}

/// <summary>
/// 生成的单张图片
/// </summary>
public sealed class ImageGenOutputItem
{
    public string? Url { get; init; }
    public string? Base64 { get; init; }
    public string? MimeType { get; init; }
    public string? RevisedPrompt { get; init; }
}
