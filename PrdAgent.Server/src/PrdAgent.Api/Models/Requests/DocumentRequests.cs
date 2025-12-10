using System.ComponentModel.DataAnnotations;

namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 文档上传请求
/// </summary>
public class UploadDocumentRequest
{
    /// <summary>Markdown文档内容</summary>
    [Required(ErrorMessage = "文档内容不能为空")]
    [MaxLength(10 * 1024 * 1024, ErrorMessage = "文档大小不能超过10MB")]
    public string Content { get; set; } = string.Empty;
}

