namespace PrdAgent.Core.Models;

/// <summary>
/// Workspace 视口偏好（缩放/相机）。
/// </summary>
public class ImageMasterViewport
{
    public double Z { get; set; } = 1;
    public double X { get; set; } = 0;
    public double Y { get; set; } = 0;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}


