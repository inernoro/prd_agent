namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷项目（跨团队可见）
/// </summary>
public class DefectProject
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>项目名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>项目标识（如 prd-agent, visual-agent）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>项目描述</summary>
    public string? Description { get; set; }

    /// <summary>项目负责人 UserId</summary>
    public string? OwnerUserId { get; set; }

    /// <summary>项目负责人名称</summary>
    public string? OwnerName { get; set; }

    /// <summary>关联的默认模板 ID</summary>
    public string? DefaultTemplateId { get; set; }

    /// <summary>是否归档</summary>
    public bool IsArchived { get; set; } = false;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
