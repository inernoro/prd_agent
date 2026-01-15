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
    private readonly ILogger<WatermarkController> _logger;

    public WatermarkController(
        MongoDbContext db,
        WatermarkFontRegistry fontRegistry,
        IAssetStorage assetStorage,
        ILogger<WatermarkController> logger)
    {
        _db = db;
        _fontRegistry = fontRegistry;
        _assetStorage = assetStorage;
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
            return Ok(ApiResponse<WatermarkSettings>.Ok(new WatermarkSettings
            {
                OwnerUserId = userId,
                Enabled = def.Enabled,
                Spec = def,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow
            }));
        }

        if (doc.Spec != null)
        {
            doc.Spec.Enabled = doc.Enabled;
        }

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

        if (request?.Spec == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "spec 不能为空"));
        }

        var spec = request.Spec;
        var allowedFontKeys = await GetAllowedFontKeysAsync(userId, ct);
        var (ok, message) = WatermarkSpecValidator.Validate(spec, allowedFontKeys);
        if (!ok)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, message ?? "水印配置无效"));
        }

        spec.Enabled = request.Spec.Enabled;

        var now = DateTime.UtcNow;
        var update = Builders<WatermarkSettings>.Update
            .Set(x => x.OwnerUserId, userId)
            .Set(x => x.Enabled, spec.Enabled)
            .Set(x => x.Spec, spec)
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

        return Ok(ApiResponse<WatermarkSettings>.Ok(saved));
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

        var defaultFonts = _fontRegistry.BuildDefaultFontInfos(fontKey => $"/api/watermark/fonts/{Uri.EscapeDataString(fontKey)}/file");
        var assets = await _db.WatermarkFontAssets
            .Find(x => x.OwnerUserId == userId)
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
        if (string.IsNullOrWhiteSpace(path)) return NotFound();
        var fileName = Path.GetFileName(path);
        var mime = "font/ttf";
        if (fileName.EndsWith(".otf", StringComparison.OrdinalIgnoreCase)) mime = "font/otf";
        if (fileName.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase)) mime = "font/woff2";
        return PhysicalFile(path, mime);
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
        var relativeFileName = _fontRegistry.SaveCustomFontFile(fontKey, ext, bytes);
        _fontRegistry.AddCustomFontDefinition(new WatermarkFontDefinition(fontKey, display, relativeFileName, familyName));

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
            .Set(x => x.FileName, relativeFileName)
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
        _fontRegistry.DeleteCustomFontFile(doc.FileName);

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
            .Find(x => x.OwnerUserId == userId)
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

    private static string? GetUserId(ClaimsPrincipal user)
    {
        return user.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
            ?? user.FindFirst("sub")?.Value
            ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value
            ?? user.FindFirst("nameid")?.Value;
    }
}
