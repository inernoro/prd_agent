namespace PrdAgent.Core.Models;

public class ImageMasterSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string OwnerUserId { get; set; } = string.Empty; // ADMIN userId
    public string Title { get; set; } = "高级视觉创作";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}


