using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;
using SixLabors.Fonts;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Drawing;
using SixLabors.ImageSharp.Drawing.Processing;
using SixLabors.ImageSharp.Formats;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace PrdAgent.Infrastructure.Services;

public class WatermarkRenderer
{
    private readonly WatermarkFontRegistry _fontRegistry;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<WatermarkRenderer> _logger;

    public WatermarkRenderer(
        WatermarkFontRegistry fontRegistry,
        IHttpClientFactory httpClientFactory,
        ILogger<WatermarkRenderer> logger)
    {
        _fontRegistry = fontRegistry;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task<(byte[] bytes, string mime)> ApplyAsync(byte[] inputBytes, string inputMime, WatermarkConfig config, CancellationToken ct)
    {
        if (inputBytes.Length == 0) return (inputBytes, inputMime);
        if (string.IsNullOrWhiteSpace(config.Text)) return (inputBytes, inputMime);

        var format = Image.DetectFormat(inputBytes);
        using var image = Image.Load<Rgba32>(inputBytes);
        var fontSize = WatermarkLayoutCalculator.CalculateScaledFontSize(config, image.Width);
        var fontResolved = _fontRegistry.ResolveFont(config.FontKey, fontSize);
        var font = fontResolved.Font;

        var textOptions = new TextOptions(font)
        {
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Top
        };
        var textSize = TextMeasurer.MeasureSize(config.Text, textOptions);
        var textHeight = textSize.Height;
        var textWidth = textSize.Width;

        var gap = textHeight / 4d;
        var iconWidth = config.IconEnabled ? textHeight + gap : 0d;
        var padding = (config.BackgroundEnabled || config.BorderEnabled) ? textHeight * 0.3d : 0d;
        var watermarkWidth = textWidth + iconWidth + padding * 2d;
        var watermarkHeight = textHeight + padding * 2d;
        var (watermarkLeft, watermarkTop) = WatermarkLayoutCalculator.CalculateWatermarkTopLeft(
            config,
            image.Width,
            image.Height,
            watermarkWidth,
            watermarkHeight);
        var textLeft = (float)(watermarkLeft + iconWidth + padding);
        var textTop = (float)(watermarkTop + padding);

        var textColor = ResolveColorHex(config.TextColor, config.Opacity);
        var borderColor = ResolveColorHex(config.BorderColor ?? config.TextColor, config.Opacity);
        var backgroundColor = ResolveColorHex(config.BackgroundColor, config.Opacity, fallback: Color.FromRgba(0, 0, 0, (byte)Math.Round(0.4 * 255)));

        image.Mutate(ctx =>
        {
            var backgroundRect = new RectangleF(
                (float)watermarkLeft,
                (float)watermarkTop,
                (float)watermarkWidth,
                (float)watermarkHeight);

            // 计算缩放后的圆角半径
            var scale = image.Width / (double)config.BaseCanvasWidth;
            var scaledCornerRadius = (float)(config.CornerRadius * scale);
            var hasRoundedCorner = scaledCornerRadius > 0;
            var hasBackground = config.BackgroundEnabled || hasRoundedCorner;

            // 计算缩放后的边框宽度
            var scaledBorderWidth = (float)(config.BorderWidth * scale);

            if (hasRoundedCorner)
            {
                // 使用圆角矩形
                var roundedPath = CreateRoundedRectanglePath(backgroundRect, scaledCornerRadius);

                if (hasBackground)
                {
                    ctx.Fill(backgroundColor, roundedPath);
                }

                if (config.BorderEnabled)
                {
                    ctx.Draw(borderColor, scaledBorderWidth, roundedPath);
                }
            }
            else if (config.BackgroundEnabled || config.BorderEnabled)
            {
                // 使用普通矩形
                if (config.BackgroundEnabled)
                {
                    ctx.Fill(backgroundColor, backgroundRect);
                }

                if (config.BorderEnabled)
                {
                    ctx.Draw(borderColor, scaledBorderWidth, backgroundRect);
                }
            }

            ctx.DrawText(config.Text, font, textColor, new PointF(textLeft, textTop));
        });

        if (config.IconEnabled && !string.IsNullOrWhiteSpace(config.IconImageRef))
        {
            try
            {
                var iconBytes = await TryLoadIconBytesAsync(config.IconImageRef, ct);
                if (iconBytes != null && iconBytes.Length > 0)
                {
                    using var icon = Image.Load<Rgba32>(iconBytes);
                    var targetSize = (int)Math.Round(textHeight);
                    if (targetSize > 0)
                    {
                        var scale = targetSize / (double)Math.Max(icon.Width, icon.Height);
                        var drawW = Math.Max(1, (int)Math.Round(icon.Width * scale));
                        var drawH = Math.Max(1, (int)Math.Round(icon.Height * scale));
                        var dx = (targetSize - drawW) / 2;
                        var dy = (targetSize - drawH) / 2;

                        using var resized = icon.Clone(ctx => ctx.Resize(new ResizeOptions
                        {
                            Size = new Size(drawW, drawH),
                            Mode = ResizeMode.Stretch,
                            Sampler = KnownResamplers.Bicubic
                        }));
                        using var canvas = new Image<Rgba32>(targetSize, targetSize);
                        canvas.Mutate(ctx => ctx.DrawImage(resized, new Point(dx, dy), 1f));
                        canvas.Mutate(ctx => ctx.Opacity((float)config.Opacity));

                        var iconLeft = (float)(watermarkLeft + padding);
                        var iconTop = (float)(watermarkTop + padding);
                        image.Mutate(ctx => ctx.DrawImage(canvas, new Point((int)iconLeft, (int)iconTop), 1f));
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to render watermark icon.");
            }
        }

        await using var ms = new MemoryStream();
        image.Save(ms, format);
        return (ms.ToArray(), format.DefaultMimeType ?? inputMime);
    }

    public async Task<(byte[] bytes, string mime)> RenderPreviewAsync(WatermarkConfig config, CancellationToken ct)
    {
        var baseSize = config.BaseCanvasWidth > 0 ? config.BaseCanvasWidth : 512;
        using var canvas = new Image<Rgba32>(baseSize, baseSize);
        canvas.Mutate(ctx => ctx.Fill(Color.FromRgba(18, 18, 22, 255)));

        await using var ms = new MemoryStream();
        canvas.SaveAsPng(ms);
        return await ApplyAsync(ms.ToArray(), "image/png", config, ct);
    }

    private static Color ResolveColorHex(string? hexInput, double opacity, Color? fallback = null)
    {
        var alpha = (byte)Math.Clamp((int)Math.Round(opacity * 255), 0, 255);
        if (string.IsNullOrWhiteSpace(hexInput))
        {
            return fallback ?? Color.FromRgba(255, 255, 255, alpha);
        }
        var hex = hexInput.Trim();
        if (hex.StartsWith('#')) hex = hex[1..];
        if (hex.Length == 6)
        {
            var r = Convert.ToByte(hex.Substring(0, 2), 16);
            var g = Convert.ToByte(hex.Substring(2, 2), 16);
            var b = Convert.ToByte(hex.Substring(4, 2), 16);
            return Color.FromRgba(r, g, b, alpha);
        }
        if (hex.Length == 8)
        {
            var r = Convert.ToByte(hex.Substring(0, 2), 16);
            var g = Convert.ToByte(hex.Substring(2, 2), 16);
            var b = Convert.ToByte(hex.Substring(4, 2), 16);
            var a = Convert.ToByte(hex.Substring(6, 2), 16);
            var combined = (byte)Math.Clamp((int)Math.Round(a * opacity), 0, 255);
            return Color.FromRgba(r, g, b, combined);
        }
        return fallback ?? Color.FromRgba(255, 255, 255, alpha);
    }

    private async Task<byte[]?> TryLoadIconBytesAsync(string iconRef, CancellationToken ct)
    {
        if (TryDecodeDataUrlOrBase64(iconRef, out var decoded)) return decoded;
        if (Uri.TryCreate(iconRef, UriKind.Absolute, out var uri) && uri.Scheme.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        {
            var client = _httpClientFactory.CreateClient();
            using var resp = await client.GetAsync(uri, ct);
            if (!resp.IsSuccessStatusCode) return null;
            var bytes = await resp.Content.ReadAsByteArrayAsync(ct);
            return bytes.Length > 0 ? bytes : null;
        }
        return null;
    }

    private static bool TryDecodeDataUrlOrBase64(string raw, out byte[] bytes)
    {
        bytes = Array.Empty<byte>();
        if (string.IsNullOrWhiteSpace(raw)) return false;
        var input = raw.Trim();
        if (input.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var comma = input.IndexOf(',');
            if (comma > 0 && comma + 1 < input.Length)
            {
                input = input[(comma + 1)..];
            }
        }

        try
        {
            bytes = Convert.FromBase64String(input);
            return bytes.Length > 0;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 创建圆角矩形路径
    /// </summary>
    private static IPath CreateRoundedRectanglePath(RectangleF rect, float cornerRadius)
    {
        // 确保圆角半径不超过矩形最小边的一半
        var maxRadius = Math.Min(rect.Width, rect.Height) / 2f;
        cornerRadius = Math.Min(cornerRadius, maxRadius);

        if (cornerRadius <= 0)
        {
            return new RectangularPolygon(rect);
        }

        // 使用多边形点来模拟圆弧，按顺时针方向绘制
        var points = new List<PointF>();
        const int segments = 16; // 每个角的圆弧分段数，增加平滑度

        // 从左上角开始，顺时针绘制
        // 左上角圆弧：从180度到270度（从左侧到顶部）
        var cx1 = rect.Left + cornerRadius;
        var cy1 = rect.Top + cornerRadius;
        for (int i = 0; i <= segments; i++)
        {
            var angle = Math.PI + (Math.PI / 2) * i / segments; // 180° -> 270°
            var x = cx1 + cornerRadius * (float)Math.Cos(angle);
            var y = cy1 + cornerRadius * (float)Math.Sin(angle);
            points.Add(new PointF(x, y));
        }

        // 右上角圆弧：从270度到360度（从顶部到右侧）
        var cx2 = rect.Right - cornerRadius;
        var cy2 = rect.Top + cornerRadius;
        for (int i = 0; i <= segments; i++)
        {
            var angle = Math.PI * 1.5 + (Math.PI / 2) * i / segments; // 270° -> 360°
            var x = cx2 + cornerRadius * (float)Math.Cos(angle);
            var y = cy2 + cornerRadius * (float)Math.Sin(angle);
            points.Add(new PointF(x, y));
        }

        // 右下角圆弧：从0度到90度（从右侧到底部）
        var cx3 = rect.Right - cornerRadius;
        var cy3 = rect.Bottom - cornerRadius;
        for (int i = 0; i <= segments; i++)
        {
            var angle = (Math.PI / 2) * i / segments; // 0° -> 90°
            var x = cx3 + cornerRadius * (float)Math.Cos(angle);
            var y = cy3 + cornerRadius * (float)Math.Sin(angle);
            points.Add(new PointF(x, y));
        }

        // 左下角圆弧：从90度到180度（从底部到左侧）
        var cx4 = rect.Left + cornerRadius;
        var cy4 = rect.Bottom - cornerRadius;
        for (int i = 0; i <= segments; i++)
        {
            var angle = Math.PI / 2 + (Math.PI / 2) * i / segments; // 90° -> 180°
            var x = cx4 + cornerRadius * (float)Math.Cos(angle);
            var y = cy4 + cornerRadius * (float)Math.Sin(angle);
            points.Add(new PointF(x, y));
        }

        return new Polygon(points.ToArray());
    }
}
