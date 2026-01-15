using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;
using SixLabors.Fonts;
using SixLabors.ImageSharp;
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

    public async Task<(byte[] bytes, string mime)> ApplyAsync(byte[] inputBytes, string inputMime, WatermarkSpec spec, CancellationToken ct)
    {
        if (inputBytes.Length == 0) return (inputBytes, inputMime);
        if (!spec.Enabled || string.IsNullOrWhiteSpace(spec.Text)) return (inputBytes, inputMime);

        var format = Image.DetectFormat(inputBytes);
        using var image = Image.Load<Rgba32>(inputBytes);
        var fontSize = WatermarkLayoutCalculator.CalculateScaledFontSize(spec, image.Width);
        var fontResolved = _fontRegistry.ResolveFont(spec.FontKey, fontSize);
        var font = fontResolved.Font;

        var textOptions = new TextOptions(font)
        {
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Top
        };
        var textSize = TextMeasurer.MeasureSize(spec.Text, textOptions);
        var textHeight = textSize.Height;
        var textWidth = textSize.Width;

        var (centerX, centerY) = WatermarkLayoutCalculator.CalculateTextCenter(spec, image.Width, image.Height);
        var textLeft = (float)(centerX - textWidth / 2);
        var textTop = (float)(centerY - textHeight / 2);

        var color = ResolveColor(spec, spec.Opacity);

        image.Mutate(ctx =>
        {
            ctx.DrawText(spec.Text, font, color, new PointF(textLeft, textTop));
        });

        if (spec.IconEnabled && !string.IsNullOrWhiteSpace(spec.IconImageRef))
        {
            try
            {
                var iconBytes = await TryLoadIconBytesAsync(spec.IconImageRef, ct);
                if (iconBytes != null && iconBytes.Length > 0)
                {
                    using var icon = Image.Load<Rgba32>(iconBytes);
                    var targetHeight = (int)Math.Round(textHeight);
                    if (targetHeight > 0)
                    {
                        icon.Mutate(i => i.Resize(new ResizeOptions
                        {
                            Size = new Size(targetHeight, targetHeight),
                            Mode = ResizeMode.Stretch
                        }));
                        icon.Mutate(i => i.Opacity((float)spec.Opacity));
                        var gap = textHeight / 4d;
                        var iconLeft = (float)(textLeft - gap - targetHeight);
                        var iconTop = textTop;
                        image.Mutate(ctx => ctx.DrawImage(icon, new Point((int)iconLeft, (int)iconTop), 1f));
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

    private static Color ResolveColor(WatermarkSpec spec, double opacity)
    {
        var alpha = (byte)Math.Clamp((int)Math.Round(opacity * 255), 0, 255);
        if (string.IsNullOrWhiteSpace(spec.Color)) return Color.FromRgba(255, 255, 255, alpha);
        var hex = spec.Color.Trim();
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
        return Color.FromRgba(255, 255, 255, alpha);
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
}
