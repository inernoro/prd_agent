namespace PrdAgent.Api.Models.Requests;

public class UpsertSystemPromptsRequest
{
    public List<UpsertSystemPromptItem> Entries { get; set; } = new();
}

public class UpsertSystemPromptItem
{
    /// <summary>仅允许 PM/DEV/QA</summary>
    public string Role { get; set; } = "PM";

    /// <summary>system prompt（非 JSON 输出任务）</summary>
    public string SystemPrompt { get; set; } = string.Empty;
}


