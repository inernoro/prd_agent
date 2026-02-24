using System.Collections.Concurrent;
using System.Net.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using SixLabors.Fonts;

namespace PrdAgent.Infrastructure.Services;

public record WatermarkFontDefinition(string FontKey, string DisplayName, string FileName, string? FontFamily = null, string? Sha256 = null);

public record WatermarkResolvedFont(Font Font, bool FallbackUsed, string? FallbackReason, string FontKey, string FontFamily);

public class WatermarkFontRegistry
{
    private const string DefaultFontKeyValue = "default";
    private const string DefaultFontFileName = "default.ttf";
    private const string DefaultFontRelativePath = "watermark/font/default.ttf";

    private readonly string _fontDir;
    private readonly string? _defaultRemoteFontUrl;
    private readonly IWatermarkFontAssetSource _fontAssetSource;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<WatermarkFontRegistry> _logger;
    private readonly FontCollection _fontCollection = new();
    private readonly ConcurrentDictionary<string, FontFamily?> _familyCache = new();
    private readonly ConcurrentDictionary<string, WatermarkFontDefinition> _customDefinitions = new();
    private readonly IReadOnlyList<WatermarkFontDefinition> _defaultDefinitions;

    public WatermarkFontRegistry(
        IHostEnvironment env,
        IWatermarkFontAssetSource fontAssetSource,
        IAssetStorage assetStorage,
        IConfiguration cfg,
        ILogger<WatermarkFontRegistry> logger)
    {
        _fontAssetSource = fontAssetSource;
        _assetStorage = assetStorage;
        _logger = logger;
        _fontDir = Path.Combine(env.ContentRootPath, "Assets", "Fonts");

        var cdnBase = (cfg["TENCENT_COS_PUBLIC_BASE_URL"] ?? string.Empty).Trim().TrimEnd('/');
        _defaultRemoteFontUrl = string.IsNullOrWhiteSpace(cdnBase) ? null : $"{cdnBase}/{DefaultFontRelativePath}";

        _defaultDefinitions = new List<WatermarkFontDefinition>
        {
            new(DefaultFontKeyValue, "Default", DefaultFontFileName, "Default")
        };
        LoadCustomDefinitionsFromDb();
    }

    public string DefaultFontKey => DefaultFontKeyValue;

    public IReadOnlyList<WatermarkFontDefinition> Definitions
        => _defaultDefinitions.Concat(_customDefinitions.Values).ToList();

    public IReadOnlyList<string> DefaultFontKeys => _defaultDefinitions.Select(x => x.FontKey).ToList();

    public IReadOnlyList<string> FontKeys => Definitions.Select(x => x.FontKey).ToList();

    public string NormalizeFontKey(string? fontKey)
    {
        var key = (fontKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(key)) return DefaultFontKey;
        if (_customDefinitions.ContainsKey(key)) return key;
        if (_defaultDefinitions.Any(x => x.FontKey.Equals(key, StringComparison.OrdinalIgnoreCase))) return key;
        return DefaultFontKey;
    }

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
            if (File.Exists(path)) return _fontCollection.Add(path);

            if (def.FontKey == DefaultFontKey)
            {
                var bytes = TryDownloadDefaultFontBytes();
                if (bytes != null && bytes.Length > 0)
                {
                    TryPersistFontBytes(path, bytes);
                    return _fontCollection.Add(new MemoryStream(bytes));
                }
            }

            if (!string.IsNullOrWhiteSpace(def.Sha256))
            {
                var result = _assetStorage.TryReadByShaAsync(
                    def.Sha256,
                    CancellationToken.None,
                    domain: AppDomainPaths.DomainWatermark,
                    type: AppDomainPaths.TypeFont).GetAwaiter().GetResult();
                if (result != null && result.Value.bytes.Length > 0)
                {
                    return _fontCollection.Add(new MemoryStream(result.Value.bytes));
                }
            }

            return null;
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

    private void LoadCustomDefinitionsFromDb()
    {
        try
        {
            var assets = _fontAssetSource.LoadAll();
            foreach (var asset in assets)
            {
                if (string.IsNullOrWhiteSpace(asset.FontKey)) continue;
                _customDefinitions[asset.FontKey] = new WatermarkFontDefinition(
                    asset.FontKey,
                    asset.DisplayName,
                    asset.FileName ?? string.Empty,
                    asset.FontFamily,
                    asset.Sha256);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to load custom watermark fonts.");
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

    /// <summary>
    /// 获取默认字体的完整 CDN URL（用于返回给前端）
    /// </summary>
    public string? DefaultFontUrl => _defaultRemoteFontUrl;

    private byte[]? TryDownloadDefaultFontBytes()
    {
        if (string.IsNullOrWhiteSpace(_defaultRemoteFontUrl))
        {
            _logger.LogWarning("No CDN base URL configured (TENCENT_COS_PUBLIC_BASE_URL), cannot download default watermark font.");
            return null;
        }

        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            var bytes = client.GetByteArrayAsync(_defaultRemoteFontUrl).GetAwaiter().GetResult();
            return bytes.Length == 0 ? null : bytes;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to download default watermark font.");
            return null;
        }
    }

    private void TryPersistFontBytes(string path, byte[] bytes)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path) ?? _fontDir);
            File.WriteAllBytes(path, bytes);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to cache watermark font file at {Path}", path);
        }
    }

    private IReadOnlyList<WatermarkFontInfo> BuildFontInfos(IEnumerable<WatermarkFontDefinition> defs, Func<string, string> fileUrlResolver)
    {
        return defs.Select(def =>
        {
            FontFamily? family = null;
            if (string.IsNullOrWhiteSpace(def.FontFamily))
            {
                family = GetOrLoadFamily(def);
            }
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
