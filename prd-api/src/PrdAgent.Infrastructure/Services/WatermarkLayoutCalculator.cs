using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

public static class WatermarkLayoutCalculator
{
    public static (double centerX, double centerY) CalculateTextCenter(WatermarkSpec spec, int targetWidth, int targetHeight)
    {
        var shortSide = Math.Min(targetWidth, targetHeight);
        var x = targetWidth / 2d + (spec.PosXRatio - 0.5d) * shortSide;
        var y = targetHeight / 2d + (spec.PosYRatio - 0.5d) * shortSide;
        return (x, y);
    }

    public static double CalculateScaledFontSize(WatermarkSpec spec, int targetWidth)
    {
        var scale = spec.BaseCanvasWidth > 0 ? targetWidth / (double)spec.BaseCanvasWidth : 1d;
        if (!double.IsFinite(scale) || scale <= 0) scale = 1d;
        return Math.Max(1d, spec.FontSizePx * scale);
    }
}
