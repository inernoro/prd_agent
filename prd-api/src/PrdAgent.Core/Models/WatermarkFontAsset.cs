using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

[AppOwnership(AppNames.Watermark, AppNames.WatermarkDisplay, IsPrimary = true)]
public class WatermarkFontAsset
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string OwnerUserId { get; set; } = string.Empty;
    public string FontKey { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string FontFamily { get; set; } = string.Empty;
    public string Sha256 { get; set; } = string.Empty;
    public string Mime { get; set; } = "application/octet-stream";
    public long SizeBytes { get; set; } = 0;
    public string Url { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
