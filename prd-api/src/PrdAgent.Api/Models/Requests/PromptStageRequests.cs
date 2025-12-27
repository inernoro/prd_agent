using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Requests;

public class UpsertPromptStagesRequest
{
    public List<UpsertPromptStageItem> Stages { get; set; } = new();
}

public class UpsertPromptStageItem
{
    /// <summary>稳定阶段标识（推荐）；旧版未传时可由 Step 推导</summary>
    public string StageKey { get; set; } = string.Empty;

    /// <summary>排序号（从 1 开始）；旧版未传时可由 Step 推导</summary>
    public int Order { get; set; }

    /// <summary>兼容字段（旧版使用 Step=1..N）</summary>
    public int? Step { get; set; }

    public RoleStagePrompt Pm { get; set; } = new();
    public RoleStagePrompt Dev { get; set; } = new();
    public RoleStagePrompt Qa { get; set; } = new();
}


