namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷提交模板（Admin 配置）
/// </summary>
public class DefectTemplate
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>模板名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>模板描述</summary>
    public string? Description { get; set; }

    /// <summary>示范内容（一个完整的缺陷报告示例，展示理想的书写方式）</summary>
    public string? ExampleContent { get; set; }

    /// <summary>必填字段定义</summary>
    public List<DefectTemplateField> RequiredFields { get; set; } = new();

    /// <summary>AI 审核系统提示词</summary>
    public string? AiSystemPrompt { get; set; }

    /// <summary>是否为默认模板</summary>
    public bool IsDefault { get; set; }

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>分享给的用户 ID 列表</summary>
    public List<string>? SharedWith { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 模板字段定义
/// </summary>
public class DefectTemplateField
{
    /// <summary>字段标识（如 title, steps, severity）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>字段标签（如 "问题标题", "复现步骤"）</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>字段类型：text, select</summary>
    public string Type { get; set; } = "text";

    /// <summary>是否必填</summary>
    public bool Required { get; set; } = true;

    /// <summary>select 类型的选项</summary>
    public List<string>? Options { get; set; }

    /// <summary>占位符提示</summary>
    public string? Placeholder { get; set; }

    /// <summary>AI 追问时使用的提示语</summary>
    public string? AiPrompt { get; set; }
}
