namespace PrdAgent.Core.Models;

public class WatermarkSettings
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string OwnerUserId { get; set; } = string.Empty;

    public bool Enabled { get; set; }

    public WatermarkSpec Spec { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
