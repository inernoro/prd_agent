namespace PrdAgent.Core.Models;

public class WatermarkSpec
{
    public bool Enabled { get; set; }

    public string Text { get; set; } = string.Empty;

    public string FontKey { get; set; } = string.Empty;

    public double FontSizePx { get; set; }

    public double Opacity { get; set; }

    public string PositionMode { get; set; } = "pixel";

    public string Anchor { get; set; } = "bottom-right";

    public double OffsetX { get; set; } = 24;

    public double OffsetY { get; set; } = 24;

    public bool IconEnabled { get; set; }

    public string? IconImageRef { get; set; }

    public int BaseCanvasWidth { get; set; }

    public string? ModelKey { get; set; }

    public string? Color { get; set; }
}
