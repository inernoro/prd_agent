namespace PrdAgent.Core.Models;

public class WatermarkSpec
{
    public bool Enabled { get; set; }

    public string Text { get; set; } = string.Empty;

    public string FontKey { get; set; } = string.Empty;

    public double FontSizePx { get; set; }

    public double Opacity { get; set; }

    public double PosXRatio { get; set; }

    public double PosYRatio { get; set; }

    public bool IconEnabled { get; set; }

    public string? IconImageRef { get; set; }

    public int BaseCanvasWidth { get; set; }

    public string? ModelKey { get; set; }

    public string? Color { get; set; }

    public bool ScaleWithImage { get; set; }
}
