namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷文件夹（用于组织缺陷）
/// </summary>
public class DefectFolder
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>文件夹名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>描述</summary>
    public string? Description { get; set; }

    /// <summary>显示颜色（十六进制，如 #FF5500）</summary>
    public string? Color { get; set; }

    /// <summary>图标（可选，用于前端显示）</summary>
    public string? Icon { get; set; }

    /// <summary>排序权重（越大越靠前）</summary>
    public int SortOrder { get; set; } = 0;

    /// <summary>
    /// 空间 ID（预留，用于未来多空间支持）
    /// 默认所有人共享同一个空间，spaceId = null 或 "default"
    /// </summary>
    public string? SpaceId { get; set; }

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
