using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

public static class WatermarkLayoutCalculator
{
    public static (double left, double top) CalculateWatermarkTopLeft(
        WatermarkConfig config,
        int targetWidth,
        int targetHeight,
        double watermarkWidth,
        double watermarkHeight)
    {
        var offsetX = config.PositionMode.Equals("ratio", StringComparison.OrdinalIgnoreCase)
            ? config.OffsetX * targetWidth
            : config.OffsetX;
        var offsetY = config.PositionMode.Equals("ratio", StringComparison.OrdinalIgnoreCase)
            ? config.OffsetY * targetHeight
            : config.OffsetY;

        var left = config.Anchor switch
        {
            "top-left" => offsetX,
            "top-right" => targetWidth - watermarkWidth - offsetX,
            "bottom-left" => offsetX,
            _ => targetWidth - watermarkWidth - offsetX
        };

        var top = config.Anchor switch
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

    public static double CalculateScaleFactor(WatermarkConfig config, int targetWidth, int targetHeight)
    {
        if (config.BaseCanvasWidth <= 0) return 1d;
        if (config.AdaptiveScaleMode == 0) return 1d;

        var basis = config.AdaptiveScaleMode switch
        {
            1 => Math.Max(targetWidth, targetHeight),
            2 => Math.Min(targetWidth, targetHeight),
            3 => targetWidth,
            4 => targetHeight,
            _ => targetWidth
        };

        var scale = basis / (double)config.BaseCanvasWidth;
        if (!double.IsFinite(scale) || scale <= 0) return 1d;
        return scale;
    }

    public static double CalculateScaledFontSize(WatermarkConfig config, int targetWidth, int targetHeight)
    {
        var scale = CalculateScaleFactor(config, targetWidth, targetHeight);
        return Math.Max(1d, config.FontSizePx * scale);
    }
}
