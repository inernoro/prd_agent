using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;
using SixLabors.Fonts;

namespace PrdAgent.Infrastructure.Services;

public record WatermarkFontDefinition(string FontKey, string DisplayName, string FileName, string? FontFamily = null);

public record WatermarkResolvedFont(Font Font, bool FallbackUsed, string? FallbackReason, string FontKey, string FontFamily);

public class WatermarkFontRegistry
{
    private readonly string _fontDir;
    private readonly ILogger<WatermarkFontRegistry> _logger;
    private readonly FontCollection _fontCollection = new();
    private readonly ConcurrentDictionary<string, FontFamily?> _familyCache = new();

    public WatermarkFontRegistry(IHostEnvironment env, ILogger<WatermarkFontRegistry> logger)
    {
        _logger = logger;
        _fontDir = Path.Combine(env.ContentRootPath, "Assets", "Fonts");
    }

    public string DefaultFontKey => "dejavu-sans";

    public IReadOnlyList<WatermarkFontDefinition> Definitions { get; } = new List<WatermarkFontDefinition>
    {
        new("dejavu-sans", "DejaVu Sans", "DejaVuSans.ttf")
    };

    public IReadOnlyList<string> FontKeys => Definitions.Select(x => x.FontKey).ToList();

    public string? TryResolveFontFile(string fontKey)
    {
        var def = Definitions.FirstOrDefault(x => x.FontKey == fontKey);
        if (def == null) return null;
        var path = Path.Combine(_fontDir, def.FileName);
        return File.Exists(path) ? path : null;
    }

    public WatermarkResolvedFont ResolveFont(string fontKey, double fontSizePx)
    {
        var def = Definitions.FirstOrDefault(x => x.FontKey == fontKey);
        if (def == null)
        {
            _logger.LogWarning("Watermark font key {FontKey} not found. Falling back to {FallbackKey}.", fontKey, DefaultFontKey);
            return ResolveFont(DefaultFontKey, fontSizePx) with
            {
                FallbackUsed = true,
                FallbackReason = $"fontKey {fontKey} not found",
                FontKey = DefaultFontKey
            };
        }

        var family = GetOrLoadFamily(def);
        if (family is { } familyValue)
        {
            var font = familyValue.CreateFont((float)fontSizePx, FontStyle.Regular);
            return new WatermarkResolvedFont(font, false, null, def.FontKey, familyValue.Name);
        }

        if (def.FontKey != DefaultFontKey)
        {
            _logger.LogWarning("Watermark font file missing for key {FontKey}. Falling back to {FallbackKey}.", def.FontKey, DefaultFontKey);
            var fallback = ResolveFont(DefaultFontKey, fontSizePx);
            return fallback with { FallbackUsed = true, FallbackReason = $"font file missing for {def.FontKey}" };
        }

        throw new FileNotFoundException($"Watermark font file missing: {def.FileName}");
    }

    public FontFamily? TryResolveFamily(string fontKey)
    {
        var def = Definitions.FirstOrDefault(x => x.FontKey == fontKey);
        return def == null ? null : GetOrLoadFamily(def);
    }

    private FontFamily? GetOrLoadFamily(WatermarkFontDefinition def)
    {
        return _familyCache.GetOrAdd(def.FontKey, _ =>
        {
            var path = Path.Combine(_fontDir, def.FileName);
            if (!File.Exists(path)) return null;
            return _fontCollection.Add(path);
        });
    }

    public IReadOnlyList<WatermarkFontInfo> BuildFontInfos(Func<string, string> fileUrlResolver)
    {
        return Definitions.Select(def =>
        {
            var family = GetOrLoadFamily(def);
            var familyName = family?.Name ?? def.FontFamily ?? def.DisplayName;
            return new WatermarkFontInfo
            {
                FontKey = def.FontKey,
                DisplayName = def.DisplayName,
                FontFamily = familyName,
                FontFileUrl = fileUrlResolver(def.FontKey)
            };
        }).ToList();
    }
}
