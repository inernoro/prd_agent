namespace PrdAgent.Core.Models;

/// <summary>
/// 周计划模板 - 定义计划的结构和填写要求
/// </summary>
public class WeeklyPlanTemplate
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>模板名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>模板描述</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>模板包含的段落/表单字段</summary>
    public List<TemplateSectionDef> Sections { get; set; } = new();

    /// <summary>是否为系统内置模板（内置不可删除）</summary>
    public bool IsBuiltIn { get; set; }

    /// <summary>是否激活（未激活的模板不会出现在用户选择列表中）</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>提交截止时间规则（如 "monday 10:00" 表示周一上午10点前提交）</summary>
    public string? SubmitDeadline { get; set; }

    /// <summary>创建者 userId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 模板段落定义 - 描述每个填写区域的类型和约束
/// </summary>
public class TemplateSectionDef
{
    /// <summary>段落 ID（用于关联填写数据）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>段落标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>
    /// 段落类型：
    /// - text: 自由文本
    /// - list: 列表（每项一行）
    /// - table: 表格（有列定义）
    /// - progress: 进度（0-100%）
    /// - checklist: 勾选列表
    /// </summary>
    public string Type { get; set; } = "text";

    /// <summary>是否必填</summary>
    public bool Required { get; set; }

    /// <summary>占位符/提示文字</summary>
    public string? Placeholder { get; set; }

    /// <summary>最大条目数（仅 list/checklist 有效）</summary>
    public int? MaxItems { get; set; }

    /// <summary>表格列定义（仅 table 类型有效）</summary>
    public List<TableColumnDef>? Columns { get; set; }

    /// <summary>排序号</summary>
    public int Order { get; set; }
}

/// <summary>
/// 表格列定义
/// </summary>
public class TableColumnDef
{
    /// <summary>列名</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// 列类型：text, number, select, date, progress
    /// </summary>
    public string Type { get; set; } = "text";

    /// <summary>选项列表（仅 select 类型有效）</summary>
    public List<string>? Options { get; set; }

    /// <summary>列宽度（可选，如 "120px" 或 "2fr"）</summary>
    public string? Width { get; set; }
}
