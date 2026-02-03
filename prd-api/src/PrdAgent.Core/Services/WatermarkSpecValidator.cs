using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

public static class WatermarkSpecValidator
{
    public const int MaxTextChars = 120;
    public const int MinFontSizePx = 6;
    public const int MaxFontSizePx = 512;
    public const int MinCanvasWidth = 64;
    public const int MaxCanvasWidth = 4096;
    public const int MinScaleMode = 0;
    public const int MaxScaleMode = 4;
    public const double MinCornerRadius = 0;
    public const double MaxCornerRadius = 100;
    public const double MinBorderWidth = 1;
    public const double MaxBorderWidth = 20;
    public const double MinIconGapPx = 0;
    public const double MaxIconGapPx = 200;
    public const double MinIconScale = 0.2;
    public const double MaxIconScale = 3;

    private static readonly Regex HexColorRegex = new("^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", RegexOptions.Compiled);
    private static readonly HashSet<string> AllowedPositionModes = new(StringComparer.OrdinalIgnoreCase) { "pixel", "ratio" };
    private static readonly HashSet<string> AllowedAnchors = new(StringComparer.OrdinalIgnoreCase)
    {
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right"
    };
    private static readonly HashSet<string> AllowedIconPositions = new(StringComparer.OrdinalIgnoreCase)
    {
        "left",
        "right",
        "top",
        "bottom"
    };

    public static (bool ok, string? message) Validate(WatermarkConfig config, IReadOnlyCollection<string> allowedFontKeys)
    {
        if (config == null) return (false, "config 不能为空");
        if (string.IsNullOrWhiteSpace(config.Text)) return (false, "text 不能为空");
        if (config.Text.Length > MaxTextChars) return (false, $"text 过长（最多 {MaxTextChars} 字符）");
        if (string.IsNullOrWhiteSpace(config.FontKey)) return (false, "fontKey 不能为空");
        if (allowedFontKeys.Count > 0 && !allowedFontKeys.Contains(config.FontKey)) return (false, "fontKey 非法");
        if (!double.IsFinite(config.FontSizePx) || config.FontSizePx < MinFontSizePx || config.FontSizePx > MaxFontSizePx)
        {
            return (false, $"fontSizePx 必须在 {MinFontSizePx}-{MaxFontSizePx} 范围内");
        }
        if (!double.IsFinite(config.Opacity) || config.Opacity < 0 || config.Opacity > 1)
        {
            return (false, "opacity 必须在 0-1 之间");
        }
        if (string.IsNullOrWhiteSpace(config.PositionMode) || !AllowedPositionModes.Contains(config.PositionMode))
        {
            return (false, "positionMode 必须为 pixel 或 ratio");
        }
        if (string.IsNullOrWhiteSpace(config.Anchor) || !AllowedAnchors.Contains(config.Anchor))
        {
            return (false, "anchor 必须为 top-left/top-right/bottom-left/bottom-right");
        }
        if (!double.IsFinite(config.OffsetX) || config.OffsetX < 0)
        {
            return (false, "offsetX 必须为非负数");
        }
        if (!double.IsFinite(config.OffsetY) || config.OffsetY < 0)
        {
            return (false, "offsetY 必须为非负数");
        }
        if (config.PositionMode.Equals("ratio", StringComparison.OrdinalIgnoreCase))
        {
            if (config.OffsetX > 1 || config.OffsetY > 1)
            {
                return (false, "按比例时 offsetX/offsetY 必须在 0-1 之间");
            }
        }
        if (config.BaseCanvasWidth < MinCanvasWidth || config.BaseCanvasWidth > MaxCanvasWidth)
        {
            return (false, $"baseCanvasWidth 必须在 {MinCanvasWidth}-{MaxCanvasWidth} 范围内");
        }
        if (config.AdaptiveScaleMode < MinScaleMode || config.AdaptiveScaleMode > MaxScaleMode)
        {
            return (false, $"adaptiveScaleMode 必须在 {MinScaleMode}-{MaxScaleMode} 范围内");
        }
        if (config.IconEnabled && string.IsNullOrWhiteSpace(config.IconImageRef))
        {
            return (false, "启用图标时必须提供 iconImageRef");
        }
        if (!string.IsNullOrWhiteSpace(config.IconPosition) && !AllowedIconPositions.Contains(config.IconPosition))
        {
            return (false, "iconPosition 必须为 left/right/top/bottom");
        }
        if (!double.IsFinite(config.IconGapPx) || config.IconGapPx < MinIconGapPx || config.IconGapPx > MaxIconGapPx)
        {
            return (false, $"iconGapPx 必须在 {MinIconGapPx}-{MaxIconGapPx} 范围内");
        }
        if (!double.IsFinite(config.IconScale) || config.IconScale < MinIconScale || config.IconScale > MaxIconScale)
        {
            return (false, $"iconScale 必须在 {MinIconScale}-{MaxIconScale} 范围内");
        }
        if (!string.IsNullOrWhiteSpace(config.TextColor) && !HexColorRegex.IsMatch(config.TextColor))
        {
            return (false, "textColor 必须为 #RRGGBB 或 #RRGGBBAA");
        }
        if (!string.IsNullOrWhiteSpace(config.BorderColor) && !HexColorRegex.IsMatch(config.BorderColor))
        {
            return (false, "borderColor 必须为 #RRGGBB 或 #RRGGBBAA");
        }
        if (!double.IsFinite(config.BorderWidth) || config.BorderWidth < MinBorderWidth || config.BorderWidth > MaxBorderWidth)
        {
            return (false, $"borderWidth 必须在 {MinBorderWidth}-{MaxBorderWidth} 范围内");
        }
        if (!string.IsNullOrWhiteSpace(config.BackgroundColor) && !HexColorRegex.IsMatch(config.BackgroundColor))
        {
            return (false, "backgroundColor 必须为 #RRGGBB 或 #RRGGBBAA");
        }
        if (!double.IsFinite(config.CornerRadius) || config.CornerRadius < MinCornerRadius || config.CornerRadius > MaxCornerRadius)
        {
            return (false, $"cornerRadius 必须在 {MinCornerRadius}-{MaxCornerRadius} 范围内");
        }

        return (true, null);
    }
}
