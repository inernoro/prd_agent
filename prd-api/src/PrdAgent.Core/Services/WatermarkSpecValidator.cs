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
        if (!double.IsFinite(spec.PosXRatio) || spec.PosXRatio < 0 || spec.PosXRatio > 1)
        {
            return (false, "posXRatio 必须在 0-1 之间");
        }
        if (!double.IsFinite(spec.PosYRatio) || spec.PosYRatio < 0 || spec.PosYRatio > 1)
        {
            return (false, "posYRatio 必须在 0-1 之间");
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

        return (true, null);
    }
}
