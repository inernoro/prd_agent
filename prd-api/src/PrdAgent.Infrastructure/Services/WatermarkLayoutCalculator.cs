using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

public static class WatermarkLayoutCalculator
{
    public static (double centerX, double centerY) CalculateTextCenter(WatermarkSpec spec, int targetWidth)
    {
        var x = spec.PosXRatio * targetWidth;
        var y = spec.PosYRatio * targetWidth;
        return (x, y);
    }

    public static double CalculateScaledFontSize(WatermarkSpec spec, int targetWidth)
    {
        var scale = spec.BaseCanvasWidth > 0 ? targetWidth / (double)spec.BaseCanvasWidth : 1d;
        if (!double.IsFinite(scale) || scale <= 0) scale = 1d;
        return Math.Max(1d, spec.FontSizePx * scale);
    }
}
