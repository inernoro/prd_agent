using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 首页资源（四张快捷卡背景 + Agent 封面图/视频）
/// Slot 命名：`card.{id}` / `agent.{agentKey}.image` / `agent.{agentKey}.video`
/// COS 路径：`icon/homepage/{slot-with-dots-as-slashes}.{ext}`
/// </summary>
[ApiController]
[Route("api/assets/homepage")]
[Authorize]
[AdminController("assets", AdminPermissionCatalog.AssetsRead, WritePermission = AdminPermissionCatalog.AssetsWrite)]
public class HomepageAssetsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<HomepageAssetsController> _logger;
    private readonly IAssetStorage _assetStorage;

    // 允许 a-z0-9._- ，首字符必须字母/数字；点号用于分段（card.marketplace / agent.prd-agent.image）
    private static readonly Regex SlotRegex = new(@"^[a-z0-9][a-z0-9._\-]{0,127}$", RegexOptions.Compiled);
    private const long MaxUploadBytes = 20 * 1024 * 1024; // 20MB：图片 + 短视频

    public HomepageAssetsController(MongoDbContext db, ILogger<HomepageAssetsController> logger, IAssetStorage assetStorage)
    {
        _db = db;
        _logger = logger;
        _assetStorage = assetStorage;
    }

    private static (bool ok, string? error, string normalized) NormalizeSlot(string slot)
    {
        var s = (slot ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(s)) return (false, "slot 不能为空", s);
        if (s.Length > 128) return (false, "slot 不能超过 128 字符", s);
        if (s.Contains('/') || s.Contains('\\')) return (false, "slot 不允许包含 / 或 \\", s);
        if (s.Contains("..", StringComparison.Ordinal)) return (false, "slot 不允许包含 ..", s);
        if (!SlotRegex.IsMatch(s)) return (false, "slot 仅允许小写字母/数字/点/下划线/中划线，且需以字母或数字开头", s);
        if (s.StartsWith('.') || s.EndsWith('.')) return (false, "slot 不允许以 . 开头或结尾", s);
        return (true, null, s);
    }

    private static string ExtractExtensionFromFileName(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)) return "png";
        var ext = Path.GetExtension(fileName)?.TrimStart('.').ToLowerInvariant();
        return string.IsNullOrWhiteSpace(ext) ? "png" : ext;
    }

    private static string GuessExtensionFromMime(string mime)
    {
        var m = (mime ?? string.Empty).Trim().ToLowerInvariant();
        if (m.Contains("gif")) return "gif";
        if (m.Contains("png")) return "png";
        if (m.Contains("webp")) return "webp";
        if (m.Contains("svg")) return "svg";
        if (m.Contains("jpeg") || m.Contains("jpg")) return "jpg";
        if (m.Contains("mp4")) return "mp4";
        if (m.Contains("webm")) return "webm";
        if (m.Contains("quicktime") || m.Contains("mov")) return "mov";
        return "png";
    }

    private static string GuessMimeByExt(string ext)
    {
        var e = (ext ?? string.Empty).Trim().ToLowerInvariant().TrimStart('.');
        return e switch
        {
            "png" => "image/png",
            "jpg" or "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            _ => "application/octet-stream"
        };
    }

    private static string BuildObjectKey(string slot, string ext)
    {
        // slot 的点号替换为斜线，作为 COS 目录结构
        var path = slot.Replace('.', '/');
        return $"icon/homepage/{path}.{ext}";
    }

    private static HomepageAssetDto ToDto(HomepageAsset x) => new()
    {
        Slot = x.Slot,
        Url = x.Url,
        Mime = x.Mime,
        SizeBytes = x.SizeBytes,
        UpdatedAt = x.UpdatedAt
    };

    /// <summary>
    /// 列表：返回所有已上传的首页资源。
    /// </summary>
    [HttpGet("list")]
    [ProducesResponseType(typeof(ApiResponse<List<HomepageAssetDto>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var list = await _db.HomepageAssets.Find(_ => true).SortBy(x => x.Slot).ToListAsync(ct);
        var dto = list.Select(ToDto).ToList();
        return Ok(ApiResponse<List<HomepageAssetDto>>.Ok(dto));
    }

    /// <summary>
    /// 上传/替换：slot + 文件，按 slot 覆盖写入。
    /// </summary>
    [HttpPost("upload")]
    [RequestSizeLimit(MaxUploadBytes)]
    [ProducesResponseType(typeof(ApiResponse<HomepageAssetDto>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Upload([FromForm] string slot, [FromForm] IFormFile file, CancellationToken ct)
    {
        var adminId = this.GetRequiredUserId();

        var (ok, err, slotNorm) = NormalizeSlot(slot);
        if (!ok) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "slot 不合法"));

        if (file == null || file.Length <= 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 不能为空"));
        if (file.Length > MaxUploadBytes)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, $"文件过大（上限 {MaxUploadBytes / 1024 / 1024}MB）"));

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }
        if (bytes.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));

        var mime = (file.ContentType ?? string.Empty).Trim();
        var ext = ExtractExtensionFromFileName(file.FileName);
        if (string.IsNullOrWhiteSpace(ext) || ext == "png")
        {
            var fromMime = GuessExtensionFromMime(mime);
            if (!string.IsNullOrWhiteSpace(fromMime)) ext = fromMime;
        }
        if (string.IsNullOrWhiteSpace(mime) || mime == "application/octet-stream")
        {
            mime = GuessMimeByExt(ext);
        }

        var objectKey = BuildObjectKey(slotNorm, ext);
        await _assetStorage.UploadToKeyAsync(objectKey, bytes, mime, ct);
        var url = _assetStorage.BuildUrlForKey(objectKey);

        var now = DateTime.UtcNow;
        var existing = await _db.HomepageAssets.Find(x => x.Slot == slotNorm).Limit(1).FirstOrDefaultAsync(ct);
        if (existing == null)
        {
            var rec = new HomepageAsset
            {
                Id = Guid.NewGuid().ToString("N"),
                Slot = slotNorm,
                RelativePath = objectKey,
                Url = url,
                Mime = mime,
                SizeBytes = bytes.LongLength,
                CreatedByAdminId = adminId,
                CreatedAt = now,
                UpdatedAt = now
            };
            await _db.HomepageAssets.InsertOneAsync(rec, cancellationToken: ct);
            _logger.LogInformation("Uploaded homepage asset: slot={Slot} ext={Ext} size={Size}", slotNorm, ext, bytes.LongLength);
            return Ok(ApiResponse<HomepageAssetDto>.Ok(ToDto(rec)));
        }

        // 如扩展名变化，尝试清理旧 COS 对象（忽略错误）
        if (!string.Equals(existing.RelativePath, objectKey, StringComparison.Ordinal))
        {
            try { await _assetStorage.DeleteByKeyAsync(existing.RelativePath, ct); }
            catch (Exception ex) { _logger.LogWarning("Failed to delete old homepage asset {Key}: {Msg}", existing.RelativePath, ex.Message); }
        }

        await _db.HomepageAssets.UpdateOneAsync(
            x => x.Id == existing.Id,
            Builders<HomepageAsset>.Update
                .Set(x => x.RelativePath, objectKey)
                .Set(x => x.Url, url)
                .Set(x => x.Mime, mime)
                .Set(x => x.SizeBytes, bytes.LongLength)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        existing.RelativePath = objectKey;
        existing.Url = url;
        existing.Mime = mime;
        existing.SizeBytes = bytes.LongLength;
        existing.UpdatedAt = now;

        _logger.LogInformation("Replaced homepage asset: slot={Slot} ext={Ext} size={Size}", slotNorm, ext, bytes.LongLength);
        return Ok(ApiResponse<HomepageAssetDto>.Ok(ToDto(existing)));
    }

    /// <summary>
    /// 删除：按 slot 同时清理 DB 记录 + COS 对象。
    /// </summary>
    [HttpDelete("{slot}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Delete([FromRoute] string slot, CancellationToken ct)
    {
        var (ok, err, slotNorm) = NormalizeSlot(slot);
        if (!ok) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "slot 不合法"));

        var existing = await _db.HomepageAssets.Find(x => x.Slot == slotNorm).Limit(1).FirstOrDefaultAsync(ct);
        if (existing == null)
            return Ok(ApiResponse<object>.Ok(new { deleted = false, reason = "not found" }));

        try { await _assetStorage.DeleteByKeyAsync(existing.RelativePath, ct); }
        catch (Exception ex) { _logger.LogWarning("Failed to delete homepage asset object {Key}: {Msg}", existing.RelativePath, ex.Message); }

        var res = await _db.HomepageAssets.DeleteOneAsync(x => x.Id == existing.Id, ct);
        _logger.LogWarning("Admin deleted homepage asset slot={Slot}", slotNorm);
        return Ok(ApiResponse<object>.Ok(new { deleted = res.DeletedCount > 0 }));
    }
}

/// <summary>
/// 用户侧首页资源读取（任意登录用户可读，无管理员权限要求）。
/// LandingPage 通过此端点拉取上传的卡片背景/Agent 封面进行覆盖渲染。
/// </summary>
[ApiController]
[Route("api/homepage/assets")]
[Authorize]
public class HomepageAssetsPublicController : ControllerBase
{
    private readonly MongoDbContext _db;

    public HomepageAssetsPublicController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 返回 slot → {url, mime} 的字典，前端按需合并到默认资源上。
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<Dictionary<string, HomepageAssetDto>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetAll(CancellationToken ct)
    {
        var list = await _db.HomepageAssets.Find(_ => true).ToListAsync(ct);
        var map = list.ToDictionary(
            x => x.Slot,
            x => new HomepageAssetDto
            {
                Slot = x.Slot,
                Url = x.Url,
                Mime = x.Mime,
                SizeBytes = x.SizeBytes,
                UpdatedAt = x.UpdatedAt
            });
        return Ok(ApiResponse<Dictionary<string, HomepageAssetDto>>.Ok(map));
    }
}
