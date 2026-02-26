namespace PrdAgent.Core.Models;

public class ArenaSlot
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string DisplayName { get; set; } = "";    // "GPT-4o" - shown after reveal
    public string PlatformId { get; set; } = "";     // reference to llm_platforms
    public string ModelId { get; set; } = "";        // platform-side model identifier
    public string Group { get; set; } = "";          // group key like "global-frontier"
    public int SortOrder { get; set; }
    public bool Enabled { get; set; } = true;
    public string? AvatarColor { get; set; }         // "#10a37f"
    public string? Description { get; set; }         // "OpenAI 旗舰模型"
    public string CreatedBy { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
