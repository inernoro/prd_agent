namespace PrdAgent.Core.Models;

public class ArenaBattle
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string UserId { get; set; } = "";
    public string Prompt { get; set; } = "";
    public string GroupKey { get; set; } = "";
    public List<ArenaBattleResponse> Responses { get; set; } = new();
    public bool Revealed { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class ArenaBattleResponse
{
    public string SlotId { get; set; } = "";
    public string Label { get; set; } = "";          // "助手 A"
    public string DisplayName { get; set; } = "";    // "GPT-4o" (stored for history)
    public string PlatformId { get; set; } = "";
    public string ModelId { get; set; } = "";
    public string Content { get; set; } = "";
    public int? TtftMs { get; set; }
    public int? TotalMs { get; set; }
    public string Status { get; set; } = "done";     // "done" | "error"
    public string? ErrorMessage { get; set; }
}
