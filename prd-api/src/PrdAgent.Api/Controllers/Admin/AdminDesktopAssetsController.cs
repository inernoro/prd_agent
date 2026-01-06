using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - Desktop 资源管理（skins/keys/upload）
/// </summary>
[ApiController]
[Route("api/v1/admin/assets/desktop")]
[Authorize(Roles = "ADMIN")]
public class AdminDesktopAssetsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminDesktopAssetsController> _logger;
    private readonly IAssetStorage _assetStorage;
    private static readonly Regex SkinNameRegex = new(@"^[a-z0-9][a-z0-9\-_]{0,31}$", RegexOptions.Compiled);
    private static readonly Regex AssetKeyRegex = new(@"^[a-z0-9][a-z0-9_\-./]{0,127}$", RegexOptions.Compiled);
    private const long MaxUploadBytes = 5 * 1024 * 1024; // 5MB：icon/动图应很小

    public AdminDesktopAssetsController(MongoDbContext db, ILogger<AdminDesktopAssetsController> logger, IAssetStorage assetStorage)
    {
        _db = db;
        _logger = logger;
        _assetStorage = assetStorage;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    private static (bool ok, string? error, string normalized) NormalizeSkinName(string name)
    {
        var s = (name ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(s)) return (false, "皮肤名不能为空", s);
        if (s.Length > 32) return (false, "皮肤名不能超过 32 字符", s);
        if (!SkinNameRegex.IsMatch(s)) return (false, "皮肤名仅允许小写字母/数字/中划线/下划线，且需以字母或数字开头", s);
        return (true, null, s);
    }

    private static (bool ok, string? error, string normalized) NormalizeAssetKey(string key)
    {
        var s = (key ?? string.Empty).Trim().TrimStart('/').ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(s)) return (false, "资源 key 不能为空", s);
        if (s.Length > 128) return (false, "资源 key 不能超过 128 字符", s);
        if (!AssetKeyRegex.IsMatch(s)) return (false, "资源 key 仅允许小写字母/数字/下划线/中划线/点/斜杠，且需以字母或数字开头", s);
        if (s.Contains("..", StringComparison.Ordinal)) return (false, "资源 key 不允许包含 ..", s);
        if (s.Contains('\\')) return (false, "资源 key 不允许包含反斜杠", s);
        return (true, null, s);
    }

    private static string GuessMimeByKey(string key)
    {
        var k = (key ?? string.Empty).Trim().ToLowerInvariant();
        if (k.EndsWith(".gif", StringComparison.Ordinal)) return "image/gif";
        if (k.EndsWith(".png", StringComparison.Ordinal)) return "image/png";
        if (k.EndsWith(".webp", StringComparison.Ordinal)) return "image/webp";
        if (k.EndsWith(".svg", StringComparison.Ordinal)) return "image/svg+xml";
        if (k.EndsWith(".jpg", StringComparison.Ordinal) || k.EndsWith(".jpeg", StringComparison.Ordinal)) return "image/jpeg";
        if (k.EndsWith(".ico", StringComparison.Ordinal)) return "image/x-icon";
        return "application/octet-stream";
    }

    // 注意：Desktop 访问规则固定为 /icon/desktop/...；这里用固定前缀写 COS 对象 key（必须全小写）
    private static string BuildDesktopIconObjectKey(string? skin, string key)
    {
        var s = (skin ?? string.Empty).Trim().ToLowerInvariant().Trim('/');
        var k = (key ?? string.Empty).Trim().ToLowerInvariant().TrimStart('/');
        if (string.IsNullOrWhiteSpace(k)) throw new ArgumentException("key empty", nameof(key));
        return string.IsNullOrWhiteSpace(s)
            ? $"icon/desktop/{k}"
            : $"icon/desktop/{s}/{k}";
    }

    [HttpGet("skins")]
    [ProducesResponseType(typeof(ApiResponse<List<AdminDesktopAssetSkinDto>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListSkins(CancellationToken ct)
    {
        var list = await _db.DesktopAssetSkins.Find(_ => true).SortBy(x => x.Name).ToListAsync(ct);
        var dto = list.Select(x => new AdminDesktopAssetSkinDto
        {
            Id = x.Id,
            Name = x.Name,
            Enabled = x.Enabled,
            CreatedAt = x.CreatedAt,
            UpdatedAt = x.UpdatedAt
        }).ToList();
        return Ok(ApiResponse<List<AdminDesktopAssetSkinDto>>.Ok(dto));
    }

    [HttpPost("skins")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> CreateSkin([FromBody] AdminCreateDesktopAssetSkinRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cached = await _db.AdminIdempotencyRecords
                .Find(x => x.OwnerAdminId == adminId && x.Scope == "admin_desktop_assets_skins_create" && x.IdempotencyKey == idemKey)
                .FirstOrDefaultAsync(ct);
            if (cached != null && !string.IsNullOrWhiteSpace(cached.PayloadJson))
            {
                try
                {
                    var payload = JsonSerializer.Deserialize<JsonElement>(cached.PayloadJson);
                    return Ok(ApiResponse<object>.Ok(payload));
                }
                catch
                {
                    // ignore
                }
            }
        }

        var (ok, err, name) = NormalizeSkinName(request?.Name ?? string.Empty);
        if (!ok) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "皮肤名不合法"));

        var existed = await _db.DesktopAssetSkins.Find(x => x.Name == name).Limit(1).FirstOrDefaultAsync(ct);
        if (existed != null)
        {
            // 幂等语义：已存在则直接返回现有
            var payload = new AdminDesktopAssetSkinDto
            {
                Id = existed.Id,
                Name = existed.Name,
                Enabled = existed.Enabled,
                CreatedAt = existed.CreatedAt,
                UpdatedAt = existed.UpdatedAt
            };
            return Ok(ApiResponse<object>.Ok(payload));
        }

        var now = DateTime.UtcNow;
        var skin = new DesktopAssetSkin
        {
            Id = Guid.NewGuid().ToString("N"),
            Name = name,
            Enabled = request?.Enabled ?? true,
            CreatedByAdminId = adminId,
            CreatedAt = now,
            UpdatedAt = now
        };
        await _db.DesktopAssetSkins.InsertOneAsync(skin, cancellationToken: ct);
        _logger.LogWarning("Admin created desktop skin: {Skin}", skin.Name);

        var payload2 = new AdminDesktopAssetSkinDto
        {
            Id = skin.Id,
            Name = skin.Name,
            Enabled = skin.Enabled,
            CreatedAt = skin.CreatedAt,
            UpdatedAt = skin.UpdatedAt
        };

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var rec = new AdminIdempotencyRecord
            {
                Id = Guid.NewGuid().ToString("N"),
                OwnerAdminId = adminId,
                Scope = "admin_desktop_assets_skins_create",
                IdempotencyKey = idemKey,
                PayloadJson = JsonSerializer.Serialize(payload2),
                CreatedAt = now
            };
            try
            {
                await _db.AdminIdempotencyRecords.InsertOneAsync(rec, cancellationToken: ct);
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // ignore
            }
        }

        return Ok(ApiResponse<object>.Ok(payload2));
    }

    [HttpPut("skins/{id}")]
    [ProducesResponseType(typeof(ApiResponse<AdminDesktopAssetSkinDto>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateSkin([FromRoute] string id, [FromBody] AdminUpdateDesktopAssetSkinRequest request, CancellationToken ct)
    {
        var sid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var skin = await _db.DesktopAssetSkins.Find(x => x.Id == sid).Limit(1).FirstOrDefaultAsync(ct);
        if (skin == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "皮肤不存在"));

        var update = Builders<DesktopAssetSkin>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        var changed = false;
        if (request?.Enabled != null)
        {
            update = update.Set(x => x.Enabled, request.Enabled.Value);
            changed = true;
        }
        if (!changed)
        {
            return Ok(ApiResponse<AdminDesktopAssetSkinDto>.Ok(new AdminDesktopAssetSkinDto
            {
                Id = skin.Id,
                Name = skin.Name,
                Enabled = skin.Enabled,
                CreatedAt = skin.CreatedAt,
                UpdatedAt = skin.UpdatedAt
            }));
        }

        await _db.DesktopAssetSkins.UpdateOneAsync(x => x.Id == sid, update, cancellationToken: ct);
        var updated = await _db.DesktopAssetSkins.Find(x => x.Id == sid).Limit(1).FirstOrDefaultAsync(ct);
        if (updated == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "皮肤不存在"));

        return Ok(ApiResponse<AdminDesktopAssetSkinDto>.Ok(new AdminDesktopAssetSkinDto
        {
            Id = updated.Id,
            Name = updated.Name,
            Enabled = updated.Enabled,
            CreatedAt = updated.CreatedAt,
            UpdatedAt = updated.UpdatedAt
        }));
    }

    [HttpDelete("skins/{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> DeleteSkin([FromRoute] string id, CancellationToken ct)
    {
        var sid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(sid))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var res = await _db.DesktopAssetSkins.DeleteOneAsync(x => x.Id == sid, ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = res.DeletedCount > 0 }));
    }

    // ---------------- Keys ----------------

    [HttpGet("keys")]
    [ProducesResponseType(typeof(ApiResponse<List<AdminDesktopAssetKeyDto>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListKeys(CancellationToken ct)
    {
        var list = await _db.DesktopAssetKeys.Find(_ => true).SortBy(x => x.Key).ToListAsync(ct);
        var dto = list.Select(x => new AdminDesktopAssetKeyDto
        {
            Id = x.Id,
            Key = x.Key,
            Kind = x.Kind,
            Description = x.Description,
            CreatedAt = x.CreatedAt,
            UpdatedAt = x.UpdatedAt
        }).ToList();
        return Ok(ApiResponse<List<AdminDesktopAssetKeyDto>>.Ok(dto));
    }

    [HttpPost("keys")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> CreateKey([FromBody] AdminCreateDesktopAssetKeyRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var (ok, err, key) = NormalizeAssetKey(request?.Key ?? string.Empty);
        if (!ok) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "资源 key 不合法"));

        var kind = (request?.Kind ?? "image").Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(kind)) kind = "image";
        if (kind is not ("image" or "audio" or "video" or "other"))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "kind 不合法（image/audio/video/other）"));

        var existed = await _db.DesktopAssetKeys.Find(x => x.Key == key).Limit(1).FirstOrDefaultAsync(ct);
        if (existed != null)
        {
            return Ok(ApiResponse<object>.Ok(new AdminDesktopAssetKeyDto
            {
                Id = existed.Id,
                Key = existed.Key,
                Kind = existed.Kind,
                Description = existed.Description,
                CreatedAt = existed.CreatedAt,
                UpdatedAt = existed.UpdatedAt
            }));
        }

        var now = DateTime.UtcNow;
        var rec = new DesktopAssetKey
        {
            Id = Guid.NewGuid().ToString("N"),
            Key = key,
            Kind = kind,
            Description = string.IsNullOrWhiteSpace(request?.Description) ? null : request.Description.Trim(),
            CreatedByAdminId = adminId,
            CreatedAt = now,
            UpdatedAt = now
        };
        await _db.DesktopAssetKeys.InsertOneAsync(rec, cancellationToken: ct);
        _logger.LogWarning("Admin created desktop asset key: {Key} kind={Kind}", rec.Key, rec.Kind);

        return Ok(ApiResponse<object>.Ok(new AdminDesktopAssetKeyDto
        {
            Id = rec.Id,
            Key = rec.Key,
            Kind = rec.Kind,
            Description = rec.Description,
            CreatedAt = rec.CreatedAt,
            UpdatedAt = rec.UpdatedAt
        }));
    }

    [HttpDelete("keys/{id}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> DeleteKey([FromRoute] string id, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var kid = (id ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(kid))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        // 1. 获取 key 信息（为了删除对应的 COS 文件）
        var record = await _db.DesktopAssetKeys.Find(x => x.Id == kid).FirstOrDefaultAsync(ct);
        if (record == null)
            return Ok(ApiResponse<object>.Ok(new { deleted = false, reason = "not found" }));

        // 2. 删除数据库记录
        var res = await _db.DesktopAssetKeys.DeleteOneAsync(x => x.Id == kid, ct);
        if (res.DeletedCount > 0)
        {
            _logger.LogWarning("Admin deleted desktop asset key: {Key} id={Id}", record.Key, record.Id);
            
            // 3. 尝试删除 COS 文件（包括 base 和所有 skin 下的文件）
            // 注意：DesktopAssetKeys 表只存了 key 定义，并不存该 key 下有哪些 skin 的文件。
            // 这里只能通过枚举已知的 Skins + Base 来尝试删除。
            try 
            {
                var skins = await _db.DesktopAssetSkins.Find(_ => true).ToListAsync(ct);
                var pathsToDelete = new List<string>();
                
                // base path
                pathsToDelete.Add(BuildDesktopIconObjectKey(null, record.Key));
                
                // skin paths
                foreach(var s in skins)
                {
                    pathsToDelete.Add(BuildDesktopIconObjectKey(s.Name, record.Key));
                }

                // 批量删除（如果 Storage 支持批量，目前 TencentCosStorage 的 DeleteByShaAsync 是针对 sha 的，
                // 这里的 DesktopAsset 并没有 sha 索引，是直接按路径存的。
                // AdminImageMasterController 用的是 DeleteByShaAsync，但这里是直接覆盖写路径模式。
                // 也就是我们需要 DeleteObjectAsync(key)。
                
                // 检查 _assetStorage 是否有 DeleteObjectAsync 接口，或者直接转换类型调用
                if (_assetStorage is TencentCosStorage cos)
                {
                    foreach(var p in pathsToDelete)
                    {
                        // 暂时串行删除，失败不阻断流程
                        try 
                        {
                            await cos.DeleteAsync(p, ct);
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning("Failed to delete COS object {Path}: {Msg}", p, ex.Message);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error cleanup COS files for key {Key}", record.Key);
            }
        }

        return Ok(ApiResponse<object>.Ok(new { deleted = res.DeletedCount > 0 }));
    }

    // ---------------- Upload ----------------

    /// <summary>
    /// 上传/替换 Desktop 资源（覆盖写）：COS 对象 key 固定为 icon/desktop/{skin?}/{key}（全小写）。
    /// </summary>
    [HttpPost("upload")]
    [RequestSizeLimit(MaxUploadBytes)]
    [ProducesResponseType(typeof(ApiResponse<AdminDesktopAssetUploadResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Upload([FromForm] string? skin, [FromForm] string key, [FromForm] IFormFile file, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var skinFinal = string.Empty;
        if (!string.IsNullOrWhiteSpace(skin))
        {
            var (sOk, sErr, sNorm) = NormalizeSkinName(skin);
            if (!sOk) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, sErr ?? "皮肤名不合法"));
            skinFinal = sNorm;
        }

        var (kOk, kErr, keyNorm) = NormalizeAssetKey(key);
        if (!kOk) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, kErr ?? "资源 key 不合法"));

        if (file == null || file.Length <= 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 不能为空"));
        if (file.Length > MaxUploadBytes)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "文件过大"));

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }
        if (bytes.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));

        var mime = (file.ContentType ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(mime) || mime == "application/octet-stream")
        {
            mime = GuessMimeByKey(keyNorm);
        }

        // 强约束：COS key 必须全小写（目录 + 文件名）
        var objectKey = BuildDesktopIconObjectKey(string.IsNullOrWhiteSpace(skinFinal) ? null : skinFinal, keyNorm);

        // 目前生产强制使用 TencentCosStorage；这里做显式类型检查，避免未来替换实现时 silent fail
        if (_assetStorage is not TencentCosStorage cos)
            return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "资产存储未配置为 TencentCosStorage"));

        await cos.UploadBytesAsync(objectKey, bytes, mime, ct);

        // 更新/创建 key 元数据（不存文件内容）
        var now = DateTime.UtcNow;
        var existed = await _db.DesktopAssetKeys.Find(x => x.Key == keyNorm).Limit(1).FirstOrDefaultAsync(ct);
        if (existed == null)
        {
            var rec = new DesktopAssetKey
            {
                Id = Guid.NewGuid().ToString("N"),
                Key = keyNorm,
                Kind = "image",
                CreatedByAdminId = adminId,
                CreatedAt = now,
                UpdatedAt = now
            };
            await _db.DesktopAssetKeys.InsertOneAsync(rec, cancellationToken: ct);
        }
        else
        {
            await _db.DesktopAssetKeys.UpdateOneAsync(x => x.Id == existed.Id,
                Builders<DesktopAssetKey>.Update.Set(x => x.UpdatedAt, now),
                cancellationToken: ct);
        }

        // 返回给管理端用于复制/预览的 URL：按固定规则拼接
        // 说明：Desktop 端也按同规则拼接，不需要后端下发地址规则
        var url = "https://i.pa.759800.com/" + objectKey;

        return Ok(ApiResponse<AdminDesktopAssetUploadResponse>.Ok(new AdminDesktopAssetUploadResponse
        {
            Skin = skinFinal,
            Key = keyNorm,
            Url = url,
            Mime = mime,
            SizeBytes = bytes.LongLength
        }));
    }
}


