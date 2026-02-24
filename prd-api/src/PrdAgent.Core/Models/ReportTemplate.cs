namespace PrdAgent.Core.Models;

/// <summary>
/// 周报模板
/// </summary>
public class ReportTemplate
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>模板名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>模板描述</summary>
    public string? Description { get; set; }

    /// <summary>模板章节定义</summary>
    public List<ReportTemplateSection> Sections { get; set; } = new();

    /// <summary>绑定团队 ID（null 表示通用模板）</summary>
    public string? TeamId { get; set; }

    /// <summary>绑定岗位名称（null 表示不限岗位）</summary>
    public string? JobTitle { get; set; }

    /// <summary>是否为默认模板</summary>
    public bool IsDefault { get; set; }

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 周报模板章节定义
/// </summary>
public class ReportTemplateSection
{
    /// <summary>章节标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>章节描述/填写提示</summary>
    public string? Description { get; set; }

    /// <summary>输入类型：bullet-list / rich-text / key-value / progress-table</summary>
    public string InputType { get; set; } = ReportInputType.BulletList;

    /// <summary>是否必填</summary>
    public bool IsRequired { get; set; } = true;

    /// <summary>排序序号</summary>
    public int SortOrder { get; set; }

    /// <summary>数据源提示（Phase 2 用于 AI 自动采集）</summary>
    public string? DataSourceHint { get; set; }

    /// <summary>最大条目数限制</summary>
    public int? MaxItems { get; set; }
}

/// <summary>
/// 周报输入类型常量
/// </summary>
public static class ReportInputType
{
    public const string BulletList = "bullet-list";
    public const string RichText = "rich-text";
    public const string KeyValue = "key-value";
    public const string ProgressTable = "progress-table";

    public static readonly string[] All = { BulletList, RichText, KeyValue, ProgressTable };
}
