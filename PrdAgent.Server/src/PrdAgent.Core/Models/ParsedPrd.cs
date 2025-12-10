namespace PrdAgent.Core.Models;

/// <summary>
/// 解析后的PRD文档
/// </summary>
public class ParsedPrd
{
    /// <summary>文档唯一标识</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString();
    
    /// <summary>文档标题</summary>
    public string Title { get; set; } = string.Empty;
    
    /// <summary>原始完整内容</summary>
    public string RawContent { get; set; } = string.Empty;
    
    /// <summary>字符数</summary>
    public int CharCount { get; set; }
    
    /// <summary>Token估算值</summary>
    public int TokenEstimate { get; set; }
    
    /// <summary>章节结构</summary>
    public List<Section> Sections { get; set; } = new();
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 文档章节
/// </summary>
public class Section
{
    /// <summary>标题层级 (1-6)</summary>
    public int Level { get; set; }
    
    /// <summary>标题文本</summary>
    public string Title { get; set; } = string.Empty;
    
    /// <summary>章节内容</summary>
    public string Content { get; set; } = string.Empty;
    
    /// <summary>起始行号</summary>
    public int StartLine { get; set; }
    
    /// <summary>结束行号</summary>
    public int EndLine { get; set; }
    
    /// <summary>子章节</summary>
    public List<Section> Children { get; set; } = new();
}



