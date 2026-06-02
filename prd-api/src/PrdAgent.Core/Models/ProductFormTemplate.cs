namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 通用自定义表单模板（元数据驱动）。
///
/// 设计目标：一套表单引擎服务 product / version / requirement / feature / customer / upgrade-request
/// 六类对象，前端按 Fields 动态渲染表单，实例把填写值存在各自的 FormData 字典里。
/// 比 DefectTemplate（仅 text/select）字段类型更丰富，见 ProductFormFieldType。
/// </summary>
public class ProductFormTemplate
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>模板名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>模板描述</summary>
    public string? Description { get; set; }

    /// <summary>
    /// 适用对象类型：product / version / requirement / feature / customer / upgrade-request
    /// 见 ProductEntityType。
    /// </summary>
    public string EntityType { get; set; } = ProductEntityType.Requirement;

    /// <summary>字段定义列表</summary>
    public List<ProductFormField> Fields { get; set; } = new();

    /// <summary>是否为该对象类型的默认模板（同一 EntityType 只应有一个默认）</summary>
    public bool IsDefault { get; set; }

    /// <summary>所属产品 ID（为空表示全局模板，可被所有产品复用）</summary>
    public string? ProductId { get; set; }

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}

/// <summary>
/// 表单字段定义。Type 决定前端渲染控件 + 校验方式。
/// </summary>
public class ProductFormField
{
    /// <summary>字段标识（如 background / acceptanceCriteria，唯一，作为 FormData 的 key）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>字段标签（如 "需求背景"）</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>字段类型，见 ProductFormFieldType</summary>
    public string Type { get; set; } = ProductFormFieldType.Text;

    /// <summary>是否必填</summary>
    public bool Required { get; set; }

    /// <summary>select / multiselect / radio 的可选项</summary>
    public List<ProductFormFieldOption>? Options { get; set; }

    /// <summary>占位符 / 提示</summary>
    public string? Placeholder { get; set; }

    /// <summary>字段说明（帮助文案）</summary>
    public string? HelpText { get; set; }

    /// <summary>默认值（字符串化存储，前端按 Type 解析）</summary>
    public string? DefaultValue { get; set; }

    /// <summary>
    /// 当 Type=relation 时，关联的对象类型（product / version / requirement / feature / customer），
    /// 前端据此弹出对应对象选择器。
    /// </summary>
    public string? RelationEntityType { get; set; }

    /// <summary>数值 / 日期类的最小值（字符串化）</summary>
    public string? Min { get; set; }

    /// <summary>数值 / 日期类的最大值（字符串化）</summary>
    public string? Max { get; set; }

    /// <summary>排序权重（小的在前）</summary>
    public int SortOrder { get; set; }
}

/// <summary>select / radio / multiselect 选项</summary>
public class ProductFormFieldOption
{
    public string Value { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    /// <summary>选项颜色（可选，用于标签着色）</summary>
    public string? Color { get; set; }
}

/// <summary>表单字段类型常量</summary>
public static class ProductFormFieldType
{
    public const string Text = "text";
    public const string Textarea = "textarea";
    public const string Number = "number";
    public const string Select = "select";
    public const string MultiSelect = "multiselect";
    public const string Radio = "radio";
    public const string Checkbox = "checkbox";
    public const string Date = "date";
    public const string DateTime = "datetime";
    /// <summary>选择系统用户</summary>
    public const string User = "user";
    /// <summary>关联其他产品对象（配合 RelationEntityType）</summary>
    public const string Relation = "relation";
    /// <summary>富文本</summary>
    public const string RichText = "richtext";
    /// <summary>文件 / 附件</summary>
    public const string File = "file";

    public static readonly string[] All =
    {
        Text, Textarea, Number, Select, MultiSelect, Radio, Checkbox,
        Date, DateTime, User, Relation, RichText, File,
    };
}

/// <summary>产品管理对象类型常量（表单 / 状态机 / 关系图共用的对象维度）</summary>
public static class ProductEntityType
{
    public const string Product = "product";
    public const string Version = "version";
    public const string Requirement = "requirement";
    public const string Feature = "feature";
    public const string Customer = "customer";
    public const string UpgradeRequest = "upgrade-request";

    public static readonly string[] All =
    {
        Product, Version, Requirement, Feature, Customer, UpgradeRequest,
    };
}
