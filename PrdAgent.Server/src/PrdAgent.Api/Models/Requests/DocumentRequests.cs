namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 文档上传请求
/// </summary>
public class UploadDocumentRequest
{
    private const int MaxContentSize = 10 * 1024 * 1024;

    /// <summary>Markdown文档内容</summary>
    public string Content { get; set; } = string.Empty;

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



