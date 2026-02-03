using System.IdentityModel.Tokens.Jwt;
using System.IO.Compression;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using SixLabors.Fonts;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats;

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

    /// <summary>
    /// 获取用户的所有水印配置列表
    /// </summary>
    [HttpGet("/api/watermarks")]
    [HttpGet("/api/v1/watermarks")]
    public async Task<IActionResult> GetWatermarks(CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var configs = await _db.WatermarkConfigs
            .Find(x => x.UserId == userId)
            .SortByDescending(x => x.UpdatedAt)
            .ToListAsync(ct);

        foreach (var config in configs)
        {
            config.PreviewUrl = BuildPreviewUrl(config.Id);
        }

        return Ok(ApiResponse<List<WatermarkConfig>>.Ok(configs));
    }

    /// <summary>
    /// 获取某应用关联的水印配置
    /// </summary>
    [HttpGet("/api/watermarks/app/{appKey}")]
    [HttpGet("/api/v1/watermarks/app/{appKey}")]
    public async Task<IActionResult> GetWatermarkByApp([FromRoute] string appKey, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        if (string.IsNullOrWhiteSpace(appKey))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "appKey 不能为空"));
        }

        var config = await _db.WatermarkConfigs
            .Find(x => x.UserId == userId && x.AppKeys.Contains(appKey))
            .FirstOrDefaultAsync(ct);

        if (config != null)
        {
            config.PreviewUrl = BuildPreviewUrl(config.Id);
        }

        return Ok(ApiResponse<WatermarkConfig?>.Ok(config));
    }

    /// <summary>
    /// 创建新的水印配置
    /// </summary>
    [HttpPost("/api/watermarks")]
    [HttpPost("/api/v1/watermarks")]
    public async Task<IActionResult> CreateWatermark([FromBody] CreateWatermarkRequest request, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var allowedFontKeys = await GetAllowedFontKeysAsync(userId, ct);
        var config = BuildConfigFromRequest(request, userId, allowedFontKeys);

        var (ok, message) = WatermarkSpecValidator.Validate(config, allowedFontKeys);
        if (!ok)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, message ?? "水印配置无效"));
        }

        if (config.IconEnabled && !string.IsNullOrWhiteSpace(config.IconImageRef))
        {
            var (iconOk, normalized) = await NormalizeIconRefAsync(config.IconImageRef, ct);
            if (!iconOk || string.IsNullOrWhiteSpace(normalized))
            {
                return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "图标必须先上传到腾讯云"));
            }
            config.IconImageRef = normalized;
        }

        // 处理预览底图
        if (!string.IsNullOrWhiteSpace(config.PreviewBackgroundImageRef))
        {
            var (bgOk, bgNormalized) = await NormalizeIconRefAsync(config.PreviewBackgroundImageRef, ct);
            if (bgOk && !string.IsNullOrWhiteSpace(bgNormalized))
            {
                config.PreviewBackgroundImageRef = bgNormalized;
            }
        }

        await _db.WatermarkConfigs.InsertOneAsync(config, cancellationToken: ct);

        _logger.LogInformation("Watermark created for user {UserId}. Id={Id}", userId, config.Id);

        try
        {
            await RenderAndSavePreviewAsync(config, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to render watermark preview for {Id}", config.Id);
        }

        config.PreviewUrl = BuildPreviewUrl(config.Id);
        return Ok(ApiResponse<WatermarkConfig>.Ok(config));
    }

    /// <summary>
    /// 更新水印配置
    /// </summary>
    [HttpPut("/api/watermarks/{id}")]
    [HttpPut("/api/v1/watermarks/{id}")]
    public async Task<IActionResult> UpdateWatermark([FromRoute] string id, [FromBody] UpdateWatermarkRequest request, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var existing = await _db.WatermarkConfigs
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        if (existing == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "水印配置不存在"));
        }

        var allowedFontKeys = await GetAllowedFontKeysAsync(userId, ct);
        ApplyUpdateToConfig(existing, request, allowedFontKeys);

        var (ok, message) = WatermarkSpecValidator.Validate(existing, allowedFontKeys);
        if (!ok)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, message ?? "水印配置无效"));
        }

        if (existing.IconEnabled && !string.IsNullOrWhiteSpace(existing.IconImageRef))
        {
            var (iconOk, normalized) = await NormalizeIconRefAsync(existing.IconImageRef, ct);
            if (!iconOk || string.IsNullOrWhiteSpace(normalized))
            {
                return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "图标必须先上传到腾讯云"));
            }
            existing.IconImageRef = normalized;
        }

        // 处理预览底图
        if (!string.IsNullOrWhiteSpace(existing.PreviewBackgroundImageRef))
        {
            var (bgOk, bgNormalized) = await NormalizeIconRefAsync(existing.PreviewBackgroundImageRef, ct);
            if (bgOk && !string.IsNullOrWhiteSpace(bgNormalized))
            {
                existing.PreviewBackgroundImageRef = bgNormalized;
            }
        }

        // 如果是从海鲜市场下载的配置，修改后清除来源标记
        if (existing.ForkedFromId != null)
        {
            existing.IsModifiedAfterFork = true;
            existing.ForkedFromId = null;
            existing.ForkedFromUserId = null;
            existing.ForkedFromUserName = null;
            existing.ForkedFromUserAvatar = null;
        }

        existing.UpdatedAt = DateTime.UtcNow;

        await _db.WatermarkConfigs.ReplaceOneAsync(
            x => x.Id == id && x.UserId == userId,
            existing,
            cancellationToken: ct);

        _logger.LogInformation("Watermark updated for user {UserId}. Id={Id}", userId, id);

        try
        {
            await RenderAndSavePreviewAsync(existing, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to render watermark preview for {Id}", id);
        }

        existing.PreviewUrl = BuildPreviewUrl(existing.Id);
        return Ok(ApiResponse<WatermarkConfig>.Ok(existing));
    }

    /// <summary>
    /// 删除水印配置
    /// </summary>
    [HttpDelete("/api/watermarks/{id}")]
    [HttpDelete("/api/v1/watermarks/{id}")]
    public async Task<IActionResult> DeleteWatermark([FromRoute] string id, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        var result = await _db.WatermarkConfigs.DeleteOneAsync(
            x => x.Id == id && x.UserId == userId,
            ct);

        if (result.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "水印配置不存在"));
        }

        _logger.LogInformation("Watermark deleted for user {UserId}. Id={Id}", userId, id);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 绑定应用到水印（同时解绑该用户其他水印的该应用）
    /// </summary>
    [HttpPost("/api/watermarks/{id}/bind/{appKey}")]
    [HttpPost("/api/v1/watermarks/{id}/bind/{appKey}")]
    public async Task<IActionResult> BindApp([FromRoute] string id, [FromRoute] string appKey, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        if (string.IsNullOrWhiteSpace(appKey))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "appKey 不能为空"));
        }

        var target = await _db.WatermarkConfigs
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        if (target == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "水印配置不存在"));
        }

        // 先从该用户所有水印中移除这个 appKey
        await _db.WatermarkConfigs.UpdateManyAsync(
            x => x.UserId == userId && x.AppKeys.Contains(appKey),
            Builders<WatermarkConfig>.Update.Pull(x => x.AppKeys, appKey),
            cancellationToken: ct);

        // 再添加到目标水印
        if (!target.AppKeys.Contains(appKey))
        {
            await _db.WatermarkConfigs.UpdateOneAsync(
                x => x.Id == id && x.UserId == userId,
                Builders<WatermarkConfig>.Update
                    .AddToSet(x => x.AppKeys, appKey)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
        }

        _logger.LogInformation("App {AppKey} bound to watermark {Id} for user {UserId}", appKey, id, userId);

        var updated = await _db.WatermarkConfigs
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        if (updated != null)
        {
            updated.PreviewUrl = BuildPreviewUrl(updated.Id);
        }

        return Ok(ApiResponse<WatermarkConfig?>.Ok(updated));
    }

    /// <summary>
    /// 解绑应用
    /// </summary>
    [HttpDelete("/api/watermarks/{id}/unbind/{appKey}")]
    [HttpDelete("/api/v1/watermarks/{id}/unbind/{appKey}")]
    public async Task<IActionResult> UnbindApp([FromRoute] string id, [FromRoute] string appKey, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        if (string.IsNullOrWhiteSpace(appKey))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "appKey 不能为空"));
        }

        var result = await _db.WatermarkConfigs.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            Builders<WatermarkConfig>.Update
                .Pull(x => x.AppKeys, appKey)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        if (result.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "水印配置不存在"));
        }

        _logger.LogInformation("App {AppKey} unbound from watermark {Id} for user {UserId}", appKey, id, userId);
        return Ok(ApiResponse<object>.Ok(new { unbound = true }));
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

        var config = await _db.WatermarkConfigs
            .Find(x => x.Id == watermarkId && x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        if (config == null)
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

    /// <summary>
    /// 测试水印：上传图片，应用指定水印配置，返回带水印的图片
    /// 单张图片返回图片文件，多张图片返回 ZIP 压缩包
    /// </summary>
    [HttpPost("/api/watermarks/{id}/test")]
    [RequestSizeLimit(100 * 1024 * 1024)] // 100MB for multiple files
    public async Task<IActionResult> TestWatermark([FromRoute] string id, [FromForm] List<IFormFile> files, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        if (files == null || files.Count == 0 || files.All(f => f.Length == 0))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传图片文件"));
        }

        var config = await _db.WatermarkConfigs
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        if (config == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "水印配置不存在"));
        }

        try
        {
            // 过滤掉空文件
            var validFiles = files.Where(f => f.Length > 0).ToList();
            
            // 单文件：直接返回图片
            if (validFiles.Count == 1)
            {
                var file = validFiles[0];
                await using var ms = new MemoryStream();
                await file.CopyToAsync(ms, ct);
                var inputBytes = ms.ToArray();
                var inputMime = file.ContentType ?? "image/png";

                var (resultBytes, resultMime) = await _watermarkRenderer.ApplyAsync(inputBytes, inputMime, config, ct);

                var fileName = $"watermark-test-{DateTime.UtcNow:yyyyMMddHHmmss}.png";
                Response.Headers.Append("Content-Disposition", $"attachment; filename=\"{fileName}\"");
                return File(resultBytes, resultMime);
            }
            
            // 多文件：返回 ZIP 压缩包
            await using var zipStream = new MemoryStream();
            using (var archive = new ZipArchive(zipStream, ZipArchiveMode.Create, leaveOpen: true))
            {
                var index = 0;
                foreach (var file in validFiles)
                {
                    index++;
                    try
                    {
                        await using var fileMs = new MemoryStream();
                        await file.CopyToAsync(fileMs, ct);
                        var inputBytes = fileMs.ToArray();
                        var inputMime = file.ContentType ?? "image/png";

                        var (resultBytes, _) = await _watermarkRenderer.ApplyAsync(inputBytes, inputMime, config, ct);

                        // 使用原文件名或生成文件名
                        var originalName = Path.GetFileNameWithoutExtension(file.FileName);
                        var entryName = string.IsNullOrWhiteSpace(originalName) 
                            ? $"watermark-{index:D3}.png" 
                            : $"{originalName}-watermark.png";
                        
                        var entry = archive.CreateEntry(entryName, CompressionLevel.Fastest);
                        await using var entryStream = entry.Open();
                        await entryStream.WriteAsync(resultBytes, ct);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Failed to process file {Index} in batch watermark test", index);
                        // 继续处理其他文件
                    }
                }
            }
            
            zipStream.Position = 0;
            var zipFileName = $"watermark-test-{DateTime.UtcNow:yyyyMMddHHmmss}.zip";
            Response.Headers.Append("Content-Disposition", $"attachment; filename=\"{zipFileName}\"");
            return File(zipStream.ToArray(), "application/zip");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to apply watermark for test. ConfigId={Id}", id);
            return StatusCode(StatusCodes.Status500InternalServerError, 
                ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "水印应用失败"));
        }
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

        var defaultFonts = _fontRegistry.BuildDefaultFontInfos(_ => "https://i.pa.759800.com/watermark/font/default.ttf");
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

    [HttpPost("/api/watermark/icons")]
    [HttpPost("/api/v1/watermark/icons")]
    [RequestSizeLimit(MaxIconUploadBytes)]
    public async Task<IActionResult> UploadIcon([FromForm] IFormFile file, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));
        }

        if (_assetStorage is not TencentCosStorage)
        {
            return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "资产存储未配置为 TencentCosStorage"));
        }

        if (file == null || file.Length <= 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 不能为空"));
        }

        if (file.Length > MaxIconUploadBytes)
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

        IImageFormat? format;
        try
        {
            format = Image.DetectFormat(bytes);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Invalid watermark icon upload.");
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "图标解析失败"));
        }

        if (format == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "图标格式不支持"));
        }

        var mime = string.IsNullOrWhiteSpace(format.DefaultMimeType) ? "image/png" : format.DefaultMimeType;
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: AppDomainPaths.DomainWatermark, type: AppDomainPaths.TypeImg);
        return Ok(ApiResponse<object>.Ok(new { url = stored.Url }));
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

    private const long MaxIconUploadBytes = 5 * 1024 * 1024;
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

    private WatermarkConfig BuildConfigFromRequest(CreateWatermarkRequest request, string userId, IReadOnlyCollection<string> allowedFontKeys)
    {
        var fontKey = _fontRegistry.NormalizeFontKey(request.FontKey ?? "default");
        var textColor = request.TextColor ?? "#FFFFFF";

        var fontSize = request.FontSizePx ?? 28;
        var defaultGap = Math.Max(0, Math.Round(fontSize / 4d, 2));
        return new WatermarkConfig
        {
            UserId = userId,
            Name = string.IsNullOrWhiteSpace(request.Name) ? "默认水印" : request.Name.Trim(),
            AppKeys = new List<string>(),
            Text = request.Text ?? "米多AI生成",
            FontKey = fontKey,
            FontSizePx = fontSize,
            Opacity = request.Opacity ?? 0.6,
            PositionMode = request.PositionMode ?? "pixel",
            Anchor = request.Anchor ?? "bottom-right",
            OffsetX = request.OffsetX ?? 24,
            OffsetY = request.OffsetY ?? 24,
            IconEnabled = request.IconEnabled ?? false,
            IconImageRef = request.IconImageRef,
            IconPosition = request.IconPosition ?? "left",
            IconGapPx = request.IconGapPx ?? defaultGap,
            IconScale = request.IconScale ?? 1,
            BorderEnabled = request.BorderEnabled ?? false,
            BorderColor = request.BorderColor,
            BorderWidth = request.BorderWidth ?? 2,
            BackgroundEnabled = request.BackgroundEnabled ?? false,
            RoundedBackgroundEnabled = request.RoundedBackgroundEnabled ?? false,
            CornerRadius = request.CornerRadius ?? 0,
            BaseCanvasWidth = request.BaseCanvasWidth ?? 320,
            AdaptiveScaleMode = request.AdaptiveScaleMode ?? 0,
            TextColor = textColor,
            BackgroundColor = request.BackgroundColor ?? "#000000",
            PreviewBackgroundImageRef = request.PreviewBackgroundImageRef,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };
    }

    private void ApplyUpdateToConfig(WatermarkConfig config, UpdateWatermarkRequest request, IReadOnlyCollection<string> allowedFontKeys)
    {
        if (request.Name != null) config.Name = request.Name.Trim();
        if (request.Text != null) config.Text = request.Text;
        if (request.FontKey != null) config.FontKey = _fontRegistry.NormalizeFontKey(request.FontKey);
        if (request.FontSizePx.HasValue) config.FontSizePx = request.FontSizePx.Value;
        if (request.Opacity.HasValue) config.Opacity = request.Opacity.Value;
        if (request.PositionMode != null) config.PositionMode = request.PositionMode;
        if (request.Anchor != null) config.Anchor = request.Anchor;
        if (request.OffsetX.HasValue) config.OffsetX = request.OffsetX.Value;
        if (request.OffsetY.HasValue) config.OffsetY = request.OffsetY.Value;
        if (request.IconEnabled.HasValue) config.IconEnabled = request.IconEnabled.Value;
        if (request.IconImageRef != null) config.IconImageRef = request.IconImageRef;
        if (request.IconPosition != null) config.IconPosition = request.IconPosition;
        if (request.IconGapPx.HasValue) config.IconGapPx = request.IconGapPx.Value;
        if (request.IconScale.HasValue) config.IconScale = request.IconScale.Value;
        if (request.BorderEnabled.HasValue) config.BorderEnabled = request.BorderEnabled.Value;
        if (request.BorderColor != null) config.BorderColor = request.BorderColor;
        if (request.BorderWidth.HasValue) config.BorderWidth = request.BorderWidth.Value;
        if (request.BackgroundEnabled.HasValue) config.BackgroundEnabled = request.BackgroundEnabled.Value;
        if (request.RoundedBackgroundEnabled.HasValue) config.RoundedBackgroundEnabled = request.RoundedBackgroundEnabled.Value;
        if (request.CornerRadius.HasValue) config.CornerRadius = request.CornerRadius.Value;
        if (request.BaseCanvasWidth.HasValue) config.BaseCanvasWidth = request.BaseCanvasWidth.Value;
        if (request.AdaptiveScaleMode.HasValue) config.AdaptiveScaleMode = request.AdaptiveScaleMode.Value;
        if (request.TextColor != null) config.TextColor = request.TextColor;
        if (request.BackgroundColor != null) config.BackgroundColor = request.BackgroundColor;
        if (request.PreviewBackgroundImageRef != null) config.PreviewBackgroundImageRef = request.PreviewBackgroundImageRef;
    }

    private async Task<(bool ok, string? normalized)> NormalizeIconRefAsync(string iconRef, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(iconRef)) return (true, iconRef);
        if (!TryDecodeDataUrlOrBase64(iconRef, out var mime, out var bytes)) return (true, iconRef);
        if (_assetStorage is not TencentCosStorage) return (false, null);
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: AppDomainPaths.DomainWatermark, type: AppDomainPaths.TypeImg);
        return (true, stored.Url);
    }

    private static bool TryDecodeDataUrlOrBase64(string raw, out string mime, out byte[] bytes)
    {
        mime = "application/octet-stream";
        bytes = Array.Empty<byte>();
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return false;

        if (s.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var comma = s.IndexOf(',');
            if (comma < 0) return false;
            var header = s.Substring(5, comma - 5);
            var payload = s[(comma + 1)..];
            var semi = header.IndexOf(';');
            var ct = semi >= 0 ? header[..semi] : header;
            if (!string.IsNullOrWhiteSpace(ct)) mime = ct.Trim();
            s = payload.Trim();
        }

        try
        {
            bytes = Convert.FromBase64String(s);
            return bytes.Length > 0;
        }
        catch
        {
            return false;
        }
    }

    private static string BuildPreviewFileName(string watermarkId)
    {
        return $"preview.{watermarkId}.png";
    }

    private async Task RenderAndSavePreviewAsync(WatermarkConfig config, CancellationToken ct)
    {
        var (bytes, mime) = await _watermarkRenderer.RenderPreviewAsync(config, ct);
        if (bytes.Length == 0) return;
        await SavePreviewAsync(BuildPreviewFileName(config.Id), bytes, string.IsNullOrWhiteSpace(mime) ? "image/png" : mime, ct);
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

        _logger.LogWarning("Watermark preview storage skipped: asset storage does not support fixed name.");
    }

    private string? BuildPreviewUrl(string watermarkId)
    {
        if (string.IsNullOrWhiteSpace(watermarkId)) return null;
        var fileName = BuildPreviewFileName(watermarkId);
        var domain = AppDomainPaths.DomainWatermark;
        var type = AppDomainPaths.TypeImg;
        var key = $"{AppDomainPaths.NormDomain(domain)}/{AppDomainPaths.NormType(type)}/{fileName}";

        if (_assetStorage is TencentCosStorage cosStorage)
        {
            return cosStorage.BuildPublicUrl(key);
        }

        var baseUrl = $"{Request.Scheme}://{Request.Host}";
        var pathBase = Request.PathBase.HasValue ? Request.PathBase.Value : string.Empty;
        var escapedId = Uri.EscapeDataString(watermarkId);
        return $"{baseUrl}{pathBase}/api/watermark/preview/{escapedId}.png";
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

    #region 海鲜市场 API

    /// <summary>
    /// 获取海鲜市场公开的水印配置列表
    /// </summary>
    [HttpGet("/api/watermarks/marketplace")]
    [HttpGet("/api/v1/watermarks/marketplace")]
    public async Task<IActionResult> ListMarketplace(
        [FromQuery] string? keyword,
        [FromQuery] string? sort,
        CancellationToken ct)
    {
        var filterBuilder = Builders<WatermarkConfig>.Filter;
        var filter = filterBuilder.Eq(x => x.IsPublic, true);

        // 关键词搜索（按名称）
        if (!string.IsNullOrWhiteSpace(keyword))
        {
            filter = filterBuilder.And(filter, filterBuilder.Regex(x => x.Name, new MongoDB.Bson.BsonRegularExpression(keyword, "i")));
        }

        var query = _db.WatermarkConfigs.Find(filter);

        // 排序
        query = sort switch
        {
            "hot" => query.SortByDescending(x => x.ForkCount).ThenByDescending(x => x.CreatedAt),
            "new" => query.SortByDescending(x => x.CreatedAt),
            _ => query.SortByDescending(x => x.ForkCount).ThenByDescending(x => x.CreatedAt) // 默认热门
        };

        var items = await query.ToListAsync(ct);

        // 获取所有作者信息
        var ownerIds = items.Select(x => x.UserId).Distinct().ToList();
        var owners = await _db.Users
            .Find(u => ownerIds.Contains(u.UserId))
            .ToListAsync(ct);
        var ownerMap = owners.ToDictionary(u => u.UserId, u => new { name = u.DisplayName ?? u.Username, avatar = u.AvatarFileName });

        var result = items.Select(x => new
        {
            x.Id,
            x.Name,
            x.Text,
            x.FontKey,
            x.Anchor,
            x.Opacity,
            PreviewUrl = BuildPreviewUrl(x.Id),
            x.ForkCount,
            x.CreatedAt,
            ownerUserId = x.UserId,
            ownerUserName = ownerMap.TryGetValue(x.UserId, out var o) ? o.name : "未知用户",
            ownerUserAvatar = ownerMap.TryGetValue(x.UserId, out var o2) ? o2.avatar : null,
        });

        return Ok(ApiResponse<object>.Ok(new { items = result }));
    }

    /// <summary>
    /// 发布水印配置到海鲜市场
    /// </summary>
    [HttpPost("/api/watermarks/{id}/publish")]
    [HttpPost("/api/v1/watermarks/{id}/publish")]
    public async Task<IActionResult> Publish(string id, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        var config = await _db.WatermarkConfigs.Find(x => x.Id == id && x.UserId == userId).FirstOrDefaultAsync(ct);
        if (config == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "配置不存在"));

        config.IsPublic = true;
        config.UpdatedAt = DateTime.UtcNow;

        await _db.WatermarkConfigs.ReplaceOneAsync(x => x.Id == id, config, cancellationToken: ct);

        config.PreviewUrl = BuildPreviewUrl(config.Id);
        return Ok(ApiResponse<WatermarkConfig>.Ok(config));
    }

    /// <summary>
    /// 取消发布水印配置（从海鲜市场下架）
    /// </summary>
    [HttpPost("/api/watermarks/{id}/unpublish")]
    [HttpPost("/api/v1/watermarks/{id}/unpublish")]
    public async Task<IActionResult> Unpublish(string id, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        var config = await _db.WatermarkConfigs.Find(x => x.Id == id && x.UserId == userId).FirstOrDefaultAsync(ct);
        if (config == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "配置不存在"));

        config.IsPublic = false;
        config.UpdatedAt = DateTime.UtcNow;

        await _db.WatermarkConfigs.ReplaceOneAsync(x => x.Id == id, config, cancellationToken: ct);

        config.PreviewUrl = BuildPreviewUrl(config.Id);
        return Ok(ApiResponse<WatermarkConfig>.Ok(config));
    }

    /// <summary>
    /// 免费下载（Fork）海鲜市场的水印配置
    /// </summary>
    [HttpPost("/api/watermarks/{id}/fork")]
    [HttpPost("/api/v1/watermarks/{id}/fork")]
    public async Task<IActionResult> Fork(string id, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未授权"));

        var source = await _db.WatermarkConfigs.Find(x => x.Id == id && x.IsPublic).FirstOrDefaultAsync(ct);
        if (source == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "配置不存在或未公开"));

        // 获取原作者信息
        var sourceOwner = await _db.Users.Find(u => u.UserId == source.UserId).FirstOrDefaultAsync(ct);
        var sourceOwnerName = sourceOwner?.DisplayName ?? sourceOwner?.Username ?? "未知用户";
        var sourceOwnerAvatar = sourceOwner?.AvatarFileName;

        // 创建副本
        var forked = new WatermarkConfig
        {
            Id = Guid.NewGuid().ToString("N"),
            UserId = userId,
            Name = source.Name,
            AppKeys = new List<string>(), // 下载的配置默认不绑定任何应用
            Text = source.Text,
            FontKey = source.FontKey,
            FontSizePx = source.FontSizePx,
            Opacity = source.Opacity,
            PositionMode = source.PositionMode,
            Anchor = source.Anchor,
            OffsetX = source.OffsetX,
            OffsetY = source.OffsetY,
            IconEnabled = source.IconEnabled,
            IconImageRef = source.IconImageRef,
            BorderEnabled = source.BorderEnabled,
            BorderColor = source.BorderColor,
            BorderWidth = source.BorderWidth,
            BackgroundEnabled = source.BackgroundEnabled,
            RoundedBackgroundEnabled = source.RoundedBackgroundEnabled,
            CornerRadius = source.CornerRadius,
            BaseCanvasWidth = source.BaseCanvasWidth,
            TextColor = source.TextColor,
            BackgroundColor = source.BackgroundColor,
            PreviewBackgroundImageRef = source.PreviewBackgroundImageRef,
            IsPublic = false, // 下载的配置默认不公开
            ForkCount = 0,
            ForkedFromId = source.Id,
            ForkedFromUserId = source.UserId,
            ForkedFromUserName = sourceOwnerName,
            ForkedFromUserAvatar = sourceOwnerAvatar,
            IsModifiedAfterFork = false,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.WatermarkConfigs.InsertOneAsync(forked, cancellationToken: ct);

        // 更新原配置的 ForkCount
        await _db.WatermarkConfigs.UpdateOneAsync(
            x => x.Id == id,
            Builders<WatermarkConfig>.Update.Inc(x => x.ForkCount, 1),
            cancellationToken: ct);

        // 生成预览
        try
        {
            await RenderAndSavePreviewAsync(forked, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to render watermark preview for forked config {Id}", forked.Id);
        }

        forked.PreviewUrl = BuildPreviewUrl(forked.Id);
        return Ok(ApiResponse<WatermarkConfig>.Ok(forked));
    }

    #endregion
}
