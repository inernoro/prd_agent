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

    private static readonly Regex HexColorRegex = new("^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", RegexOptions.Compiled);
    private static readonly HashSet<string> AllowedPositionModes = new(StringComparer.OrdinalIgnoreCase) { "pixel", "ratio" };
    private static readonly HashSet<string> AllowedAnchors = new(StringComparer.OrdinalIgnoreCase)
    {
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right"
    };

    public static (bool ok, string? message) Validate(WatermarkSpec spec, IReadOnlyCollection<string> allowedFontKeys)
    {
        if (spec == null) return (false, "spec 不能为空");
        if (string.IsNullOrWhiteSpace(spec.Text)) return (false, "text 不能为空");
        if (spec.Text.Length > MaxTextChars) return (false, $"text 过长（最多 {MaxTextChars} 字符）");
        if (string.IsNullOrWhiteSpace(spec.FontKey)) return (false, "fontKey 不能为空");
        if (allowedFontKeys.Count > 0 && !allowedFontKeys.Contains(spec.FontKey)) return (false, "fontKey 非法");
        if (!double.IsFinite(spec.FontSizePx) || spec.FontSizePx < MinFontSizePx || spec.FontSizePx > MaxFontSizePx)
        {
            return (false, $"fontSizePx 必须在 {MinFontSizePx}-{MaxFontSizePx} 范围内");
        }
        if (!double.IsFinite(spec.Opacity) || spec.Opacity < 0 || spec.Opacity > 1)
        {
            return (false, "opacity 必须在 0-1 之间");
        }
        if (string.IsNullOrWhiteSpace(spec.PositionMode) || !AllowedPositionModes.Contains(spec.PositionMode))
        {
            return (false, "positionMode 必须为 pixel 或 ratio");
        }
        if (string.IsNullOrWhiteSpace(spec.Anchor) || !AllowedAnchors.Contains(spec.Anchor))
        {
            return (false, "anchor 必须为 top-left/top-right/bottom-left/bottom-right");
        }
        if (!double.IsFinite(spec.OffsetX) || spec.OffsetX < 0)
        {
            return (false, "offsetX 必须为非负数");
        }
        if (!double.IsFinite(spec.OffsetY) || spec.OffsetY < 0)
        {
            return (false, "offsetY 必须为非负数");
        }
        if (spec.PositionMode.Equals("ratio", StringComparison.OrdinalIgnoreCase))
        {
            if (spec.OffsetX > 1 || spec.OffsetY > 1)
            {
                return (false, "按比例时 offsetX/offsetY 必须在 0-1 之间");
            }
        }
        if (spec.BaseCanvasWidth < MinCanvasWidth || spec.BaseCanvasWidth > MaxCanvasWidth)
        {
            return (false, $"baseCanvasWidth 必须在 {MinCanvasWidth}-{MaxCanvasWidth} 范围内");
        }
        if (spec.IconEnabled && string.IsNullOrWhiteSpace(spec.IconImageRef))
        {
            return (false, "启用图标时必须提供 iconImageRef");
        }
        if (!string.IsNullOrWhiteSpace(spec.Color) && !HexColorRegex.IsMatch(spec.Color))
        {
            return (false, "color 必须为 #RRGGBB 或 #RRGGBBAA");
        }
        if (!string.IsNullOrWhiteSpace(spec.TextColor) && !HexColorRegex.IsMatch(spec.TextColor))
        {
            return (false, "textColor 必须为 #RRGGBB 或 #RRGGBBAA");
        }
        if (!string.IsNullOrWhiteSpace(spec.BackgroundColor) && !HexColorRegex.IsMatch(spec.BackgroundColor))
        {
            return (false, "backgroundColor 必须为 #RRGGBB 或 #RRGGBBAA");
        }

        return (true, null);
    }
}
