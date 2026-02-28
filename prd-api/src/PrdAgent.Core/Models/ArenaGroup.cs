namespace PrdAgent.Core.Models;

public class ArenaGroup
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Key { get; set; } = "";           // unique key like "global-frontier"
    public string Name { get; set; } = "";           // display name like "全球前沿"
    public string? Description { get; set; }
    public int SortOrder { get; set; }
    public string? Icon { get; set; }
    public string CreatedBy { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
