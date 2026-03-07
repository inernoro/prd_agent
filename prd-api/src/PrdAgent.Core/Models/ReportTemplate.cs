using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 周报模板
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
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

    /// <summary>是否为系统预置模板（不可删除/修改核心结构）</summary>
    public bool IsSystem { get; set; }

    /// <summary>模板 key（系统预置模板的唯一标识，如 "dev-general", "product-general", "minimal"）</summary>
    public string? TemplateKey { get; set; }

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

    /// <summary>v2.0 板块类型：auto-stats / auto-list / manual-list / free-text（null 时按 InputType 兼容 v1.0）</summary>
    public string? SectionType { get; set; }

    /// <summary>v2.0 关联的数据源类型（如 ["github", "tapd", "yuque"]）</summary>
    public List<string>? DataSources { get; set; }
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

/// <summary>
/// v2.0 板块类型常量
/// </summary>
public static class ReportSectionType
{
    /// <summary>自动统计 — 数字卡片展示（只读）</summary>
    public const string AutoStats = "auto-stats";

    /// <summary>自动列表 — AI 基于采集数据生成的条目（可编辑）</summary>
    public const string AutoList = "auto-list";

    /// <summary>手动列表 — 用户手动填写（必须手动输入）</summary>
    public const string ManualList = "manual-list";

    /// <summary>自由文本 — 手动输入的文本段落</summary>
    public const string FreeText = "free-text";

    public static readonly string[] All = { AutoStats, AutoList, ManualList, FreeText };
}

/// <summary>
/// 系统预置模板定义
/// </summary>
public static class SystemTemplates
{
    public const string DevGeneral = "dev-general";
    public const string ProductGeneral = "product-general";
    public const string Minimal = "minimal";

    public static ReportTemplate CreateDevGeneralTemplate() => new()
    {
        Name = "研发通用",
        Description = "适用于开发工程师的周报模板，包含代码产出、任务产出、日常工作和下周计划",
        IsDefault = true,
        IsSystem = true,
        TemplateKey = DevGeneral,
        CreatedBy = "system",
        Sections = new List<ReportTemplateSection>
        {
            new()
            {
                Title = "代码产出",
                Description = "本周代码提交、PR 合并等统计",
                InputType = ReportInputType.KeyValue,
                SectionType = ReportSectionType.AutoStats,
                DataSources = new List<string> { "github", "gitlab" },
                IsRequired = false,
                SortOrder = 0,
            },
            new()
            {
                Title = "任务产出",
                Description = "本周完成的需求、Bug 修复、任务关闭等",
                InputType = ReportInputType.KeyValue,
                SectionType = ReportSectionType.AutoStats,
                DataSources = new List<string> { "tapd" },
                IsRequired = false,
                SortOrder = 1,
            },
            new()
            {
                Title = "本周完成",
                Description = "AI 基于采集数据归纳的主要工作项",
                InputType = ReportInputType.BulletList,
                SectionType = ReportSectionType.AutoList,
                DataSources = new List<string> { "github", "tapd" },
                IsRequired = true,
                SortOrder = 2,
                MaxItems = 10,
            },
            new()
            {
                Title = "日常工作",
                Description = "会议、沟通、协作等非系统化工作",
                InputType = ReportInputType.BulletList,
                SectionType = ReportSectionType.AutoList,
                DataSources = new List<string> { "daily-log" },
                IsRequired = false,
                SortOrder = 3,
            },
            new()
            {
                Title = "下周计划",
                Description = "下周主要工作安排",
                InputType = ReportInputType.BulletList,
                SectionType = ReportSectionType.ManualList,
                IsRequired = true,
                SortOrder = 4,
                MaxItems = 8,
            },
            new()
            {
                Title = "备注",
                Description = "其他需要说明的事项",
                InputType = ReportInputType.RichText,
                SectionType = ReportSectionType.FreeText,
                IsRequired = false,
                SortOrder = 5,
            },
        },
    };

    public static ReportTemplate CreateProductGeneralTemplate() => new()
    {
        Name = "产品通用",
        Description = "适用于产品经理的周报模板，包含需求推进、文档产出和日常工作",
        IsDefault = false,
        IsSystem = true,
        TemplateKey = ProductGeneral,
        CreatedBy = "system",
        Sections = new List<ReportTemplateSection>
        {
            new()
            {
                Title = "需求推进",
                Description = "本周需求状态推进统计",
                InputType = ReportInputType.KeyValue,
                SectionType = ReportSectionType.AutoStats,
                DataSources = new List<string> { "tapd" },
                IsRequired = false,
                SortOrder = 0,
            },
            new()
            {
                Title = "文档产出",
                Description = "本周发布/更新的文档和文章统计",
                InputType = ReportInputType.KeyValue,
                SectionType = ReportSectionType.AutoStats,
                DataSources = new List<string> { "yuque" },
                IsRequired = false,
                SortOrder = 1,
            },
            new()
            {
                Title = "本周完成",
                Description = "AI 基于采集数据归纳的主要工作项",
                InputType = ReportInputType.BulletList,
                SectionType = ReportSectionType.AutoList,
                DataSources = new List<string> { "tapd", "yuque" },
                IsRequired = true,
                SortOrder = 2,
                MaxItems = 10,
            },
            new()
            {
                Title = "日常工作",
                Description = "评审、沟通、协作等非系统化工作",
                InputType = ReportInputType.BulletList,
                SectionType = ReportSectionType.AutoList,
                DataSources = new List<string> { "daily-log" },
                IsRequired = false,
                SortOrder = 3,
            },
            new()
            {
                Title = "下周计划",
                Description = "下周主要工作安排",
                InputType = ReportInputType.BulletList,
                SectionType = ReportSectionType.ManualList,
                IsRequired = true,
                SortOrder = 4,
                MaxItems = 8,
            },
        },
    };

    public static ReportTemplate CreateMinimalTemplate() => new()
    {
        Name = "极简模式",
        Description = "最简化的周报模板，仅包含产出统计和备注",
        IsDefault = false,
        IsSystem = true,
        TemplateKey = Minimal,
        CreatedBy = "system",
        Sections = new List<ReportTemplateSection>
        {
            new()
            {
                Title = "本周产出",
                Description = "合并展示所有数据源的统计",
                InputType = ReportInputType.KeyValue,
                SectionType = ReportSectionType.AutoStats,
                DataSources = new List<string> { "github", "gitlab", "tapd", "yuque" },
                IsRequired = false,
                SortOrder = 0,
            },
            new()
            {
                Title = "备注",
                Description = "补充说明",
                InputType = ReportInputType.RichText,
                SectionType = ReportSectionType.FreeText,
                IsRequired = false,
                SortOrder = 1,
            },
        },
    };

    public static List<ReportTemplate> GetAllSystemTemplates() => new()
    {
        CreateDevGeneralTemplate(),
        CreateProductGeneralTemplate(),
        CreateMinimalTemplate(),
    };
}
