using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using SixLabors.Fonts;

namespace PrdAgent.Api.Controllers;

[ApiController]
[Authorize]
public class WatermarkController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly WatermarkFontRegistry _fontRegistry;
    private readonly IAssetStorage _assetStorage;
    private readonly WatermarkRenderer _watermarkRenderer;
    private readonly ILogger<WatermarkController> _logger;

    public WatermarkController(
        MongoDbContext db,
        WatermarkFontRegistry fontRegistry,
        IAssetStorage assetStorage,
        WatermarkRenderer watermarkRenderer,
        ILogger<WatermarkController> logger)
    {
        _db = db;
        _fontRegistry = fontRegistry;
        _assetStorage = assetStorage;
        _watermarkRenderer = watermarkRenderer;
        _logger = logger;
    }

    [HttpGet("/api/user/watermark")]
    [HttpGet("/api/v1/user/watermark")]
    public async Task<IActionResult> GetWatermark(CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var doc = await _db.WatermarkSettings.Find(x => x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (doc == null)
        {
            var def = BuildDefaultSpec();
            var settings = new WatermarkSettings
            {
                OwnerUserId = userId,
                Enabled = def.Enabled,
                ActiveSpecId = def.Id,
                Specs = new List<WatermarkSpec> { def },
                Spec = def,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow
            };
            return Ok(ApiResponse<WatermarkSettings>.Ok(settings));
        }

        EnsureSpecs(doc);

        return Ok(ApiResponse<WatermarkSettings>.Ok(doc));
    }

    [HttpPut("/api/user/watermark")]
    [HttpPut("/api/v1/user/watermark")]
    public async Task<IActionResult> PutWatermark([FromBody] PutWatermarkRequest request, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var incomingSpecs = request?.Specs?.Where(x => x != null).ToList();
        if ((incomingSpecs == null || incomingSpecs.Count == 0) && request?.Spec != null)
        {
            incomingSpecs = new List<WatermarkSpec> { request.Spec };
        }

        if (incomingSpecs == null || incomingSpecs.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "spec 不能为空"));
        }

        var enabled = request?.Enabled ?? request?.Spec?.Enabled ?? incomingSpecs[0].Enabled;
        var activeSpecId = (request?.ActiveSpecId ?? request?.Spec?.Id ?? incomingSpecs[0].Id)?.Trim();

        _logger.LogInformation("Watermark PUT start for user {UserId}. Enabled={Enabled}, TotalSpecs={TotalSpecs}", userId, enabled, incomingSpecs.Count);

        var allowedFontKeys = await GetAllowedFontKeysAsync(userId, ct);

        foreach (var spec in incomingSpecs)
        {
            NormalizeSpec(spec, enabled);
            var (ok, message) = WatermarkSpecValidator.Validate(spec, allowedFontKeys);
            if (!ok)
            {
                _logger.LogWarning("Watermark PUT invalid spec for user {UserId}: {Message}", userId, message);
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, message ?? "水印配置无效"));
            }
        }

        var activeSpec = incomingSpecs.FirstOrDefault(x => string.Equals(x.Id, activeSpecId, StringComparison.OrdinalIgnoreCase))
            ?? incomingSpecs[0];
        activeSpecId = activeSpec.Id;

        var now = DateTime.UtcNow;
        var update = Builders<WatermarkSettings>.Update
            .Set(x => x.OwnerUserId, userId)
            .Set(x => x.Enabled, enabled)
            .Set(x => x.Specs, incomingSpecs)
            .Set(x => x.ActiveSpecId, activeSpecId)
            .Set(x => x.Spec, activeSpec)
            .Set(x => x.UpdatedAt, now)
            .SetOnInsert(x => x.CreatedAt, now);

        var options = new FindOneAndUpdateOptions<WatermarkSettings>
        {
            IsUpsert = true,
            ReturnDocument = ReturnDocument.After
        };

        var saved = await _db.WatermarkSettings.FindOneAndUpdateAsync(
            Builders<WatermarkSettings>.Filter.Eq(x => x.OwnerUserId, userId),
            update,
            options,
            ct);

        _logger.LogInformation("Watermark PUT saved for user {UserId}. Enabled={Enabled}, ActiveSpecId={ActiveSpecId}", userId, saved.Enabled, saved.ActiveSpecId);

        try
        {
            foreach (var spec in saved.Specs)
            {
                await RenderAndSavePreviewAsync(spec, ct).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to render watermark preview for user {UserId}", userId);
        }

        return Ok(ApiResponse<WatermarkSettings>.Ok(saved));
    }

    [HttpGet("/api/watermark/preview/{watermarkId}.png")]
    [HttpGet("/api/v1/watermark/preview/{watermarkId}.png")]
    public async Task<IActionResult> GetPreview([FromRoute] string watermarkId, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var doc = await _db.WatermarkSettings.Find(x => x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (doc == null)
        {
            return NotFound();
        }

        EnsureSpecs(doc);
        var exists = doc.Specs.Any(x => string.Equals(x.Id, watermarkId, StringComparison.OrdinalIgnoreCase));
        if (!exists)
        {
            return NotFound();
        }

        var fileName = BuildPreviewFileName(watermarkId);
        var (bytes, mime) = await TryReadPreviewAsync(fileName, ct);
        if (bytes == null || bytes.Length == 0)
        {
            return NotFound();
        }

        return File(bytes, string.IsNullOrWhiteSpace(mime) ? "image/png" : mime);
    }

    [HttpGet("/api/watermark/fonts")]
    [HttpGet("/api/v1/watermark/fonts")]
    public async Task<IActionResult> GetFonts(CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var defaultFonts = _fontRegistry.BuildDefaultFontInfos(fontKey =>
        {
            var localPath = _fontRegistry.TryResolveFontFile(fontKey);
            return localPath == null
                ? "https://i.pa.759800.com/watermark/font/default.ttf"
                : $"/api/watermark/fonts/{Uri.EscapeDataString(fontKey)}/file";
        });
        var assets = await _db.WatermarkFontAssets
            .Find(Builders<WatermarkFontAsset>.Filter.Empty)
            .SortByDescending(x => x.UpdatedAt)
            .ToListAsync(ct);
        var customFonts = assets.Select(x => new WatermarkFontInfo
        {
            FontKey = x.FontKey,
            DisplayName = x.DisplayName,
            FontFamily = x.FontFamily,
            FontFileUrl = x.Url
        }).ToList();

        return Ok(ApiResponse<IReadOnlyList<WatermarkFontInfo>>.Ok(defaultFonts.Concat(customFonts).ToList()));
    }

    [AllowAnonymous]
    [HttpGet("/api/watermark/fonts/{fontKey}/file")]
    [HttpGet("/api/v1/watermark/fonts/{fontKey}/file")]
    public IActionResult GetFontFile([FromRoute] string fontKey)
    {
        var path = _fontRegistry.TryResolveFontFile(fontKey);
        if (!string.IsNullOrWhiteSpace(path))
        {
            var fileName = Path.GetFileName(path);
            var mime = "font/ttf";
            if (fileName.EndsWith(".otf", StringComparison.OrdinalIgnoreCase)) mime = "font/otf";
            if (fileName.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase)) mime = "font/woff2";
            return PhysicalFile(path, mime);
        }

        var doc = _db.WatermarkFontAssets
            .Find(x => x.FontKey == fontKey)
            .FirstOrDefault();
        if (doc == null) return NotFound();

        try
        {
            var result = _assetStorage.TryReadByShaAsync(
                doc.Sha256,
                CancellationToken.None,
                domain: AppDomainPaths.DomainWatermark,
                type: AppDomainPaths.TypeFont).GetAwaiter().GetResult();
            if (result == null || result.Value.bytes.Length == 0) return NotFound();
            var mime = string.IsNullOrWhiteSpace(result.Value.mime) ? "font/ttf" : result.Value.mime;
            return File(result.Value.bytes, mime);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to read watermark font file {FontKey}", fontKey);
            return NotFound();
        }
    }

    [HttpPost("/api/watermark/fonts")]
    [HttpPost("/api/v1/watermark/fonts")]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<IActionResult> UploadFont([FromForm] IFormFile file, [FromForm] string? displayName, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        _logger.LogInformation("Watermark font upload start for user {UserId}. FileName={FileName}, Size={Size}", userId, file?.FileName, file?.Length ?? 0);

        if (file == null || file.Length <= 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 不能为空"));
        }

        if (file.Length > MaxUploadBytes)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "文件过大"));
        }

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        if (bytes.Length == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));
        }

        var ext = ExtractExtension(file.FileName);
        if (!IsAllowedFontExt(ext))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持 ttf/otf/woff/woff2 字体"));
        }

        var mime = GuessFontMime(file.ContentType, ext);
        string familyName;
        try
        {
            var collection = new FontCollection();
            var family = collection.Add(new MemoryStream(bytes));
            familyName = family.Name;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Invalid font upload.");
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "字体解析失败"));
        }

        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: AppDomainPaths.DomainWatermark, type: AppDomainPaths.TypeFont);
        var fontKey = BuildCustomFontKey(userId, stored.Sha256);
        var publicUrl = _assetStorage is LocalAssetStorage
            ? $"/api/watermark/fonts/{Uri.EscapeDataString(fontKey)}/file"
            : stored.Url;
        var display = NormalizeDisplayName(displayName, file.FileName, fontKey);
        var fileName = Path.GetFileName(file.FileName);
        _fontRegistry.AddCustomFontDefinition(new WatermarkFontDefinition(fontKey, display, fileName, familyName, stored.Sha256));

        var now = DateTime.UtcNow;
        var update = Builders<WatermarkFontAsset>.Update
            .Set(x => x.OwnerUserId, userId)
            .Set(x => x.FontKey, fontKey)
            .Set(x => x.DisplayName, display)
            .Set(x => x.FontFamily, familyName)
            .Set(x => x.Sha256, stored.Sha256)
            .Set(x => x.Mime, stored.Mime)
            .Set(x => x.SizeBytes, stored.SizeBytes)
            .Set(x => x.Url, publicUrl)
            .Set(x => x.FileName, fileName)
            .Set(x => x.UpdatedAt, now)
            .SetOnInsert(x => x.CreatedAt, now);

        var options = new FindOneAndUpdateOptions<WatermarkFontAsset>
        {
            IsUpsert = true,
            ReturnDocument = ReturnDocument.After
        };

        var saved = await _db.WatermarkFontAssets.FindOneAndUpdateAsync(
            Builders<WatermarkFontAsset>.Filter.Where(x => x.OwnerUserId == userId && x.FontKey == fontKey),
            update,
            options,
            ct);

        _logger.LogInformation("Watermark font upload saved for user {UserId}. FontKey={FontKey}, FileName={FileName}", userId, saved.FontKey, saved.FileName);
        return Ok(ApiResponse<WatermarkFontInfo>.Ok(new WatermarkFontInfo
        {
            FontKey = saved.FontKey,
            DisplayName = saved.DisplayName,
            FontFamily = saved.FontFamily,
            FontFileUrl = saved.Url
        }));
    }

    [HttpDelete("/api/watermark/fonts/{fontKey}")]
    [HttpDelete("/api/v1/watermark/fonts/{fontKey}")]
    public async Task<IActionResult> DeleteFont([FromRoute] string fontKey, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var doc = await _db.WatermarkFontAssets
            .Find(x => x.OwnerUserId == userId && x.FontKey == fontKey)
            .FirstOrDefaultAsync(ct);
        if (doc == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "字体不存在"));
        }

        await _db.WatermarkFontAssets.DeleteOneAsync(x => x.Id == doc.Id, ct);
        _fontRegistry.RemoveCustomFontDefinition(fontKey);

        try
        {
            await _assetStorage.DeleteByShaAsync(doc.Sha256, ct, domain: AppDomainPaths.DomainWatermark, type: AppDomainPaths.TypeFont);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Delete watermark font asset failed: {FontKey}", fontKey);
        }

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    private async Task<IReadOnlyCollection<string>> GetAllowedFontKeysAsync(string userId, CancellationToken ct)
    {
        var customKeys = await _db.WatermarkFontAssets
            .Find(Builders<WatermarkFontAsset>.Filter.Empty)
            .Project(x => x.FontKey)
            .ToListAsync(ct);
        return _fontRegistry.DefaultFontKeys.Concat(customKeys).ToList();
    }

    private const long MaxUploadBytes = 20 * 1024 * 1024;

    private static string ExtractExtension(string fileName)
    {
        var ext = Path.GetExtension(fileName ?? string.Empty);
        return string.IsNullOrWhiteSpace(ext) ? string.Empty : ext.Trim().TrimStart('.').ToLowerInvariant();
    }

    private static bool IsAllowedFontExt(string ext)
    {
        if (string.IsNullOrWhiteSpace(ext)) return false;
        return ext is "ttf" or "otf" or "woff" or "woff2";
    }

    private static string GuessFontMime(string? contentType, string ext)
    {
        var mime = (contentType ?? string.Empty).Trim().ToLowerInvariant();
        if (mime is "font/ttf" or "font/otf" or "font/woff" or "font/woff2") return mime;
        return ext switch
        {
            "otf" => "font/otf",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            _ => "font/ttf"
        };
    }

    private static string NormalizeDisplayName(string? displayName, string? fileName, string fallbackKey)
    {
        var name = (displayName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            name = Path.GetFileNameWithoutExtension(fileName ?? string.Empty).Trim();
        }
        if (string.IsNullOrWhiteSpace(name))
        {
            name = fallbackKey;
        }
        return name.Length > 64 ? name[..64] : name;
    }

    private static string BuildCustomFontKey(string userId, string sha256)
    {
        var userHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(userId)))
            .ToLowerInvariant()
            .Substring(0, 6);
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (sha.Length > 10) sha = sha[..10];
        return $"custom-{userHash}-{sha}";
    }

    private WatermarkSpec BuildDefaultSpec()
    {
        var fontKey = _fontRegistry.DefaultFontKeys.FirstOrDefault() ?? _fontRegistry.DefaultFontKey;
        return new WatermarkSpec
        {
            Enabled = false,
            Name = "默认水印",
            Text = "米多AI生成",
            FontKey = fontKey,
            FontSizePx = 28,
            Opacity = 0.6,
            PositionMode = "pixel",
            Anchor = "bottom-right",
            OffsetX = 24,
            OffsetY = 24,
            IconEnabled = false,
            IconImageRef = null,
            BorderEnabled = false,
            BackgroundEnabled = false,
            BaseCanvasWidth = 320,
            ModelKey = "default",
            Color = "#FFFFFF",
            TextColor = "#FFFFFF",
            BackgroundColor = "#000000"
        };
    }

    private void EnsureSpecs(WatermarkSettings settings)
    {
        if (settings.Specs == null || settings.Specs.Count == 0)
        {
            if (settings.Spec != null)
            {
                NormalizeSpec(settings.Spec, settings.Enabled);
                settings.Specs = new List<WatermarkSpec> { settings.Spec };
            }
            else
            {
                var def = BuildDefaultSpec();
                settings.Specs = new List<WatermarkSpec> { def };
                settings.Spec = def;
                settings.Enabled = def.Enabled;
            }
        }

        foreach (var spec in settings.Specs)
        {
            NormalizeSpec(spec, settings.Enabled);
        }

        var activeSpec = settings.Specs.FirstOrDefault(x => string.Equals(x.Id, settings.ActiveSpecId, StringComparison.OrdinalIgnoreCase))
            ?? settings.Specs.FirstOrDefault();
        if (activeSpec == null)
        {
            return;
        }
        settings.ActiveSpecId = activeSpec.Id;
        settings.Spec = activeSpec;
    }

    private void NormalizeSpec(WatermarkSpec spec, bool enabled)
    {
        if (string.IsNullOrWhiteSpace(spec.Id))
        {
            spec.Id = Guid.NewGuid().ToString("N");
        }
        if (string.IsNullOrWhiteSpace(spec.Name))
        {
            spec.Name = "水印配置";
        }
        spec.Enabled = enabled;
        spec.FontKey = _fontRegistry.NormalizeFontKey(spec.FontKey);
        if (string.IsNullOrWhiteSpace(spec.TextColor) && !string.IsNullOrWhiteSpace(spec.Color))
        {
            spec.TextColor = spec.Color;
        }
        if (string.IsNullOrWhiteSpace(spec.Color) && !string.IsNullOrWhiteSpace(spec.TextColor))
        {
            spec.Color = spec.TextColor;
        }
    }

    private static string BuildPreviewFileName(string watermarkId)
    {
        return $"preview.{watermarkId}.png";
    }

    private async Task RenderAndSavePreviewAsync(WatermarkSpec spec, CancellationToken ct)
    {
        var (bytes, mime) = await _watermarkRenderer.RenderPreviewAsync(spec, ct);
        if (bytes.Length == 0) return;
        await SavePreviewAsync(BuildPreviewFileName(spec.Id), bytes, string.IsNullOrWhiteSpace(mime) ? "image/png" : mime, ct);
    }

    private async Task SavePreviewAsync(string fileName, byte[] bytes, string mime, CancellationToken ct)
    {
        var domain = AppDomainPaths.DomainWatermark;
        var type = AppDomainPaths.TypeImg;

        if (_assetStorage is TencentCosStorage cosStorage)
        {
            var key = $"{AppDomainPaths.NormDomain(domain)}/{AppDomainPaths.NormType(type)}/{fileName}";
            await cosStorage.UploadBytesAsync(key, bytes, mime, ct);
            return;
        }

        if (_assetStorage is LocalAssetStorage)
        {
            var dir = AppDomainPaths.LocalDir(domain, type);
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, fileName);
            await System.IO.File.WriteAllBytesAsync(path, bytes, ct);
            return;
        }

        _logger.LogWarning("Watermark preview storage fallback: asset storage does not support fixed name.");
        await _assetStorage.SaveAsync(bytes, mime, ct, domain, type);
    }

    private async Task<(byte[]? bytes, string? mime)> TryReadPreviewAsync(string fileName, CancellationToken ct)
    {
        var domain = AppDomainPaths.DomainWatermark;
        var type = AppDomainPaths.TypeImg;

        if (_assetStorage is TencentCosStorage cosStorage)
        {
            var key = $"{AppDomainPaths.NormDomain(domain)}/{AppDomainPaths.NormType(type)}/{fileName}";
            var bytes = await cosStorage.TryDownloadBytesAsync(key, ct);
            return (bytes, "image/png");
        }

        if (_assetStorage is LocalAssetStorage)
        {
            var path = Path.Combine(AppDomainPaths.LocalDir(domain, type), fileName);
            if (!System.IO.File.Exists(path)) return (null, null);
            var bytes = await System.IO.File.ReadAllBytesAsync(path, ct);
            return (bytes, "image/png");
        }

        return (null, null);
    }

    private static string? GetUserId(ClaimsPrincipal user)
    {
        return user.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
            ?? user.FindFirst("sub")?.Value
            ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value
            ?? user.FindFirst("nameid")?.Value;
    }
}
