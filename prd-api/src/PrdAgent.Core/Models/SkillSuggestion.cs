namespace PrdAgent.Core.Models;

/// <summary>
/// 对话沉淀出的技能建议（用于前端确认后入库）。
/// </summary>
public class SkillSuggestion
{
    public string SuggestionId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public string SourceUserMessageId { get; set; } = string.Empty;
    public string SourceAssistantMessageId { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
    public double Confidence { get; set; }
    public List<string> Tags { get; set; } = new();

    /// <summary>
    /// 前端确认后可直接创建技能的草稿。
    /// </summary>
    public SkillSuggestionDraft Draft { get; set; } = new();
}

/// <summary>
/// 技能创建草稿（与 Skill 模型核心字段对齐）。
/// </summary>
public class SkillSuggestionDraft
{
    public string Title { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string Category { get; set; } = "general";
    public List<string> Tags { get; set; } = new();
    public SkillInputConfig Input { get; set; } = new();
    public SkillExecutionConfig Execution { get; set; } = new();
    public SkillOutputConfig Output { get; set; } = new();
}
