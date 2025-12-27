namespace PrdAgent.Core.Models;

/// <summary>
/// 阶段提示词设置（单例文档：Id 固定为 global）
/// - 阶段唯一标识：stageKey（稳定字符串）+ order（排序号）
/// - 每阶段按角色（PM/DEV/QA）分别配置 title + promptTemplate
/// </summary>
public class PromptStageSettings
{
    /// <summary>固定为 global</summary>
    public string Id { get; set; } = "global";

    public List<PromptStage> Stages { get; set; } = new();

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class PromptStage
{
    /// <summary>
    /// 稳定阶段标识（推荐 slug/uuid）；用于客户端与后端之间的稳定引用
    /// </summary>
    public string StageKey { get; set; } = string.Empty;

    /// <summary>
    /// 阶段排序号（从 1 开始），用于 UI 排序与旧 step 接口兼容
    /// </summary>
    public int Order { get; set; }

    /// <summary>
    /// 兼容字段（旧版本使用 Step=1..N）：迁移期用于读取旧数据/旧接口
    /// </summary>
    public int? Step { get; set; }

    public RoleStagePrompt Pm { get; set; } = new();
    public RoleStagePrompt Dev { get; set; } = new();
    public RoleStagePrompt Qa { get; set; } = new();
}

public class RoleStagePrompt
{
    public string Title { get; set; } = string.Empty;
    public string PromptTemplate { get; set; } = string.Empty;
}


