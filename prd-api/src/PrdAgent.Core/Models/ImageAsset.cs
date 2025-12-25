namespace PrdAgent.Core.Models;

public class ImageAsset
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string OwnerUserId { get; set; } = string.Empty;
    public string Sha256 { get; set; } = string.Empty;
    public string Mime { get; set; } = "image/png";
    public int Width { get; set; } = 0;
    public int Height { get; set; } = 0;
    public long SizeBytes { get; set; } = 0;
    public string Url { get; set; } = string.Empty;
    public string? Prompt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}


