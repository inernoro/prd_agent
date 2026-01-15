using System.Collections.Concurrent;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using SixLabors.Fonts;

namespace PrdAgent.Infrastructure.Services;

public record WatermarkFontDefinition(string FontKey, string DisplayName, string FileName, string? FontFamily = null);

public record WatermarkResolvedFont(Font Font, bool FallbackUsed, string? FallbackReason, string FontKey, string FontFamily);

public class WatermarkFontRegistry
{
    private readonly string _fontDir;
    private readonly string _customFontDir;
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<WatermarkFontRegistry> _logger;
    private readonly FontCollection _fontCollection = new();
    private readonly ConcurrentDictionary<string, FontFamily?> _familyCache = new();
    private readonly ConcurrentDictionary<string, WatermarkFontDefinition> _customDefinitions = new();
    private readonly IReadOnlyList<WatermarkFontDefinition> _defaultDefinitions;

    public WatermarkFontRegistry(
        IHostEnvironment env,
        MongoDbContext db,
        IAssetStorage assetStorage,
        ILogger<WatermarkFontRegistry> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _logger = logger;
        _fontDir = Path.Combine(env.ContentRootPath, "Assets", "Fonts");
        _customFontDir = Path.Combine(_fontDir, "Custom");
        _defaultDefinitions = new List<WatermarkFontDefinition>
        {
            new("dejavu-sans", "DejaVu Sans", "DejaVuSans.ttf")
        };
        LoadCustomDefinitionsFromDb();
    }

    public string DefaultFontKey => "dejavu-sans";

    public IReadOnlyList<WatermarkFontDefinition> Definitions
        => _defaultDefinitions.Concat(_customDefinitions.Values).ToList();

    public IReadOnlyList<string> DefaultFontKeys => _defaultDefinitions.Select(x => x.FontKey).ToList();

    public IReadOnlyList<string> FontKeys => Definitions.Select(x => x.FontKey).ToList();

    public string? TryResolveFontFile(string fontKey)
    {
        var def = FindDefinition(fontKey);
        if (def == null) return null;
        var path = ResolveFontPath(def);
        return File.Exists(path) ? path : null;
    }

    public WatermarkResolvedFont ResolveFont(string fontKey, double fontSizePx)
    {
        var def = FindDefinition(fontKey);
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
        var def = FindDefinition(fontKey);
        return def == null ? null : GetOrLoadFamily(def);
    }

    private FontFamily? GetOrLoadFamily(WatermarkFontDefinition def)
    {
        return _familyCache.GetOrAdd(def.FontKey, _ =>
        {
            var path = ResolveFontPath(def);
            if (!File.Exists(path)) return null;
            return _fontCollection.Add(path);
        });
    }

    public IReadOnlyList<WatermarkFontInfo> BuildDefaultFontInfos(Func<string, string> fileUrlResolver)
    {
        return BuildFontInfos(_defaultDefinitions, fileUrlResolver);
    }

    public void AddCustomFontDefinition(WatermarkFontDefinition definition)
    {
        _customDefinitions[definition.FontKey] = definition;
    }

    public void RemoveCustomFontDefinition(string fontKey)
    {
        _customDefinitions.TryRemove(fontKey, out _);
        _familyCache.TryRemove(fontKey, out _);
    }

    public string SaveCustomFontFile(string fontKey, string extension, byte[] bytes)
    {
        var ext = (extension ?? string.Empty).Trim().TrimStart('.').ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(ext)) ext = "ttf";
        Directory.CreateDirectory(_customFontDir);
        var fileName = $"{fontKey}.{ext}";
        var filePath = Path.Combine(_customFontDir, fileName);
        File.WriteAllBytes(filePath, bytes);
        return NormalizeCustomRelativeFileName(fileName);
    }

    public void DeleteCustomFontFile(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)) return;
        try
        {
            var path = ResolveFontPath(new WatermarkFontDefinition(string.Empty, string.Empty, fileName));
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // ignore
        }
    }

    private static string NormalizeCustomRelativeFileName(string fileName)
    {
        var rel = Path.Combine("Custom", fileName);
        return rel.Replace('\\', '/');
    }

    private void LoadCustomDefinitionsFromDb()
    {
        try
        {
            var assets = _db.WatermarkFontAssets.Find(_ => true).ToList();
            foreach (var asset in assets)
            {
                if (string.IsNullOrWhiteSpace(asset.FontKey) || string.IsNullOrWhiteSpace(asset.FileName)) continue;
                EnsureCustomFontFile(asset);
                _customDefinitions[asset.FontKey] = new WatermarkFontDefinition(
                    asset.FontKey,
                    asset.DisplayName,
                    asset.FileName,
                    asset.FontFamily);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to load custom watermark fonts.");
        }
    }

    private void EnsureCustomFontFile(WatermarkFontAsset asset)
    {
        var def = new WatermarkFontDefinition(asset.FontKey, asset.DisplayName, asset.FileName, asset.FontFamily);
        var path = ResolveFontPath(def);
        if (File.Exists(path)) return;
        try
        {
            var result = _assetStorage.TryReadByShaAsync(
                asset.Sha256,
                CancellationToken.None,
                domain: AppDomainPaths.DomainWatermark,
                type: AppDomainPaths.TypeFont).GetAwaiter().GetResult();
            if (result == null || result.Value.bytes.Length == 0) return;
            Directory.CreateDirectory(Path.GetDirectoryName(path) ?? _customFontDir);
            File.WriteAllBytes(path, result.Value.bytes);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to hydrate custom font file {FontKey}.", asset.FontKey);
        }
    }

    private WatermarkFontDefinition? FindDefinition(string fontKey)
    {
        if (_customDefinitions.TryGetValue(fontKey, out var custom)) return custom;
        return _defaultDefinitions.FirstOrDefault(x => x.FontKey == fontKey);
    }

    private string ResolveFontPath(WatermarkFontDefinition def)
    {
        if (Path.IsPathRooted(def.FileName)) return def.FileName;
        var relative = def.FileName.Replace('/', Path.DirectorySeparatorChar);
        return Path.Combine(_fontDir, relative);
    }

    private IReadOnlyList<WatermarkFontInfo> BuildFontInfos(IEnumerable<WatermarkFontDefinition> defs, Func<string, string> fileUrlResolver)
    {
        return defs.Select(def =>
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
