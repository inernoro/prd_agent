namespace PrdAgent.Core.Models;

/// <summary>
/// 更新中心「周报来源」配置。
/// 绑定一个知识库 + 文件名关键词，全员共享（任何登录用户可创建/编辑/删除）。
/// 存储集合：changelog_report_sources
/// </summary>
public class ChangelogReportSource
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>展示名称（tab 标题），例如 "MAP 周报"</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>绑定的 DocumentStore.Id</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>文件名关键词（子串匹配，留空则显示全部）</summary>
    public string Prefix { get; set; } = string.Empty;

    /// <summary>可选描述</summary>
    public string? Description { get; set; }

    /// <summary>排序（数字越小越靠前）</summary>
    public int SortOrder { get; set; }

    /// <summary>创建者 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>最近修改者 UserId</summary>
    public string UpdatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
