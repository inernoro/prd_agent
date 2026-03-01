namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 文档上传请求
/// </summary>
public class UploadDocumentRequest
{
    private const int MaxContentSize = 10 * 1024 * 1024;

    /// <summary>Markdown文档内容</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>会话标题（可选，个人调试会话用；不影响群组）</summary>
    public string? Title { get; set; }

    /// <summary>验证请求</summary>
    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (string.IsNullOrWhiteSpace(Content))
            return (false, "文档内容不能为空");
        if (Content.Length > MaxContentSize)
            return (false, "文档大小不能超过10MB");
        return (true, null);
    }
}

/// <summary>
/// 向会话追加文档请求
/// </summary>
public class AddDocumentToSessionRequest
{
    /// <summary>Markdown文档内容</summary>
    public string Content { get; set; } = string.Empty;
}
