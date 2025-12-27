namespace PrdAgent.Core.Models;

/// <summary>
/// 阶段提示词设置（单例文档：Id 固定为 global）
/// - 阶段是产品虚构的“操作分组”，仅用于引导用户理解与聚焦讨论
/// - 每条配置项即一个“角色下的阶段条目”：title + promptTemplate + order + stageKey
/// </summary>
public class PromptStageSettings
{
    /// <summary>固定为 global</summary>
    public string Id { get; set; } = "global";

    public List<PromptStageEntry> Stages { get; set; } = new();

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 单条阶段配置（对某一个角色有效）
/// </summary>
public class PromptStageEntry
{
    /// <summary>稳定标识（全局唯一）</summary>
    public string StageKey { get; set; } = string.Empty;

    /// <summary>仅允许 PM/DEV/QA</summary>
    public UserRole Role { get; set; } = UserRole.PM;

    /// <summary>该角色下的排序号（从 1 开始）</summary>
    public int Order { get; set; }

    /// <summary>小标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>阶段提示词模板</summary>
    public string PromptTemplate { get; set; } = string.Empty;
}

/// <summary>
/// 兼容类型：旧版本/旧接口曾使用的“title + promptTemplate”结构。
/// 新版内部仍可用作 DTO（例如 ChatService 注入阶段提示词时）。
/// </summary>
public class RoleStagePrompt
{
    public string Title { get; set; } = string.Empty;
    public string PromptTemplate { get; set; } = string.Empty;
}

// 兼容：旧版本（阶段内按角色分组）会在 Mongo 中存下 pm/dev/qa 等字段；新模型读取时会忽略。


