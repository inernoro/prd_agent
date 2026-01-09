namespace PrdAgent.Core.Models;

/// <summary>
/// 文章配图工作流阶段枚举（3 个状态）
/// </summary>
public enum ArticlePhase
{
    /// <summary>上传</summary>
    Upload = 0,
    
    /// <summary>预览</summary>
    Editing = 1,
    
    /// <summary>配图标记</summary>
    MarkersGenerated = 2
}
