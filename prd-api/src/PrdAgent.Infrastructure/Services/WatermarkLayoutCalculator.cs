using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

public static class WatermarkLayoutCalculator
{
    public static (double left, double top) CalculateWatermarkTopLeft(
        WatermarkSpec spec,
        int targetWidth,
        int targetHeight,
        double watermarkWidth,
        double watermarkHeight)
    {
        var offsetX = spec.PositionMode.Equals("ratio", StringComparison.OrdinalIgnoreCase)
            ? spec.OffsetX * targetWidth
            : spec.OffsetX;
        var offsetY = spec.PositionMode.Equals("ratio", StringComparison.OrdinalIgnoreCase)
            ? spec.OffsetY * targetHeight
            : spec.OffsetY;

        var left = spec.Anchor switch
        {
            "top-left" => offsetX,
            "top-right" => targetWidth - watermarkWidth - offsetX,
            "bottom-left" => offsetX,
            _ => targetWidth - watermarkWidth - offsetX
        };

        var top = spec.Anchor switch
        {
            "top-left" => offsetY,
            "top-right" => offsetY,
            "bottom-left" => targetHeight - watermarkHeight - offsetY,
            _ => targetHeight - watermarkHeight - offsetY
        };

        left = Math.Clamp(left, 0d, Math.Max(0d, targetWidth - watermarkWidth));
        top = Math.Clamp(top, 0d, Math.Max(0d, targetHeight - watermarkHeight));
        return (left, top);
    }

    public static double CalculateScaledFontSize(WatermarkSpec spec, int targetWidth)
    {
        if (!spec.ScaleWithImage)
        {
            return Math.Max(1d, spec.FontSizePx);
        }

        var scale = spec.BaseCanvasWidth > 0 ? targetWidth / (double)spec.BaseCanvasWidth : 1d;
        if (!double.IsFinite(scale) || scale <= 0) scale = 1d;
        return Math.Max(1d, spec.FontSizePx * scale);
    }
}
