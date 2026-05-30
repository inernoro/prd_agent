namespace PrdAgent.Core.Models;

/// <summary>
/// 项目知识库文件 — 项目级多格式文件（增删改查 + 分类管理）。
/// 文件本体存 IAssetStorage（同文档空间范式），本实体保存元信息 + 分类。
/// </summary>
public class PmKnowledgeFile
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属项目</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>原始文件名</summary>
    public string FileName { get; set; } = string.Empty;

    /// <summary>MIME 类型</summary>
    public string ContentType { get; set; } = string.Empty;

    /// <summary>文件大小（字节）</summary>
    public long FileSize { get; set; }

    /// <summary>存储访问 URL（IAssetStorage 返回）</summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>分类（项目内自由分类，默认"未分类"）</summary>
    public string Category { get; set; } = "未分类";

    /// <summary>上传人 UserId</summary>
    public string UploaderId { get; set; } = string.Empty;

    /// <summary>上传人名称（冗余，便于展示）</summary>
    public string? UploaderName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
