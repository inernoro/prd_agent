using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Responses;

/// <summary>
/// 文档上传响应
/// </summary>
public class UploadDocumentResponse
{
    /// <summary>会话ID</summary>
    public string SessionId { get; set; } = string.Empty;
    
    /// <summary>文档信息</summary>
    public DocumentInfo Document { get; set; } = new();
}

/// <summary>
/// 文档信息
/// </summary>
public class DocumentInfo
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public int CharCount { get; set; }
    public int TokenEstimate { get; set; }
    public List<SectionInfo> Sections { get; set; } = new();
}

/// <summary>
/// 章节信息
/// </summary>
public class SectionInfo
{
    public int Level { get; set; }
    public string Title { get; set; } = string.Empty;
    public int StartLine { get; set; }
    public int EndLine { get; set; }
    public List<SectionInfo> Children { get; set; } = new();
    
    public static SectionInfo FromSection(Section section)
    {
        return new SectionInfo
        {
            Level = section.Level,
            Title = section.Title,
            StartLine = section.StartLine,
            EndLine = section.EndLine,
            Children = section.Children.Select(FromSection).ToList()
        };
    }
}





