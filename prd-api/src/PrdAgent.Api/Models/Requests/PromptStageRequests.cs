namespace PrdAgent.Api.Models.Requests;

public class UpsertPromptsRequest
{
    public List<UpsertPromptItem> Prompts { get; set; } = new();
}

public class UpsertPromptItem
{
    /// <summary>稳定标识（全局唯一）</summary>
    public string PromptKey { get; set; } = string.Empty;

    /// <summary>仅允许 PM/DEV/QA</summary>
    public string Role { get; set; } = "PM";

    /// <summary>该角色下的排序号（从 1 开始）</summary>
    public int Order { get; set; }

    public string Title { get; set; } = string.Empty;

    public string PromptTemplate { get; set; } = string.Empty;
}


