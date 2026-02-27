using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 自服务个人资料接口：仅允许当前登录用户修改自己的头像。
/// 权限要求：access（后台基础准入），无需 users.write。
/// </summary>
[ApiController]
[Route("api/profile")]
[Authorize]
[AdminController("dashboard", AdminPermissionCatalog.Access)]
public class ProfileController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<ProfileController> _logger;
    private readonly IConfiguration _cfg;
    private readonly IAssetStorage _assetStorage;

    private const long MaxAvatarUploadBytes = 5 * 1024 * 1024; // 5MB

    public ProfileController(
        MongoDbContext db,
        ILogger<ProfileController> logger,
        IConfiguration cfg,
        IAssetStorage assetStorage)
    {
        _db = db;
        _logger = logger;
        _cfg = cfg;
        _assetStorage = assetStorage;
    }

    private string? GetCurrentUserId()
        => User.FindFirstValue(ClaimTypes.NameIdentifier)
           ?? User.FindFirstValue("sub");

    private string? BuildAvatarUrl(User user)
        => AvatarUrlBuilder.Build(_cfg, user);

    // ─── 共用校验逻辑（与 UsersController 保持一致） ───

    private static string? NormalizeAvatarImageExt(string? extOrDotExt)
    {
        var ext = (extOrDotExt ?? string.Empty).Trim().ToLowerInvariant();
        if (ext.StartsWith('.')) ext = ext[1..];
        if (string.IsNullOrWhiteSpace(ext)) return null;
        if (ext == "jpeg") ext = "jpg";
        return ext is "png" or "jpg" or "gif" or "webp" ? ext : null;
    }

    private static string? GuessAvatarImageExtFromMime(string? mime)
    {
        var m = (mime ?? string.Empty).Trim().ToLowerInvariant();
        if (m == "image/png") return "png";
        if (m == "image/jpeg") return "jpg";
        if (m == "image/gif") return "gif";
        if (m == "image/webp") return "webp";
        return null;
    }

    private static string GuessAvatarMimeFromExt(string ext)
    {
        var e = (ext ?? string.Empty).Trim().ToLowerInvariant();
        return e switch
        {
            "png" => "image/png",
            "jpg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "application/octet-stream"
        };
    }

    private static (bool ok, string? error) ValidateAvatarFileName(string? avatarFileName)
    {
        if (string.IsNullOrWhiteSpace(avatarFileName)) return (true, null);
        var t = avatarFileName.Trim();
        if (t.Length > 120) return (false, "头像文件名过长");
        if (t.Contains('/') || t.Contains('\\')) return (false, "头像文件名不允许包含路径分隔符");
        if (t.Contains("..")) return (false, "头像文件名不合法");
        if (!Regex.IsMatch(t, @"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")) return (false, "头像文件名不合法（仅允许字母数字及 . _ -）");
        return (true, null);
    }

    /// <summary>
    /// 上传并更新当前用户自己的头像
    /// </summary>
    [HttpPost("avatar/upload")]
    [RequestSizeLimit(MaxAvatarUploadBytes)]
    [ProducesResponseType(typeof(ApiResponse<UserAvatarUploadResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UploadMyAvatar([FromForm] IFormFile file, CancellationToken ct)
    {
        var currentUserId = GetCurrentUserId();
        if (string.IsNullOrWhiteSpace(currentUserId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未登录"));

        var user = await _db.Users.Find(u => u.UserId == currentUserId).FirstOrDefaultAsync(ct);
        if (user == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));

        if (file == null || file.Length <= 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 不能为空"));
        if (file.Length > MaxAvatarUploadBytes)
            return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "文件过大"));

        var ext = NormalizeAvatarImageExt(Path.GetExtension(file.FileName ?? string.Empty));
        var mime = (file.ContentType ?? string.Empty).Trim();
        if (ext == null)
            ext = GuessAvatarImageExtFromMime(mime);
        if (ext == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持图片格式：png/jpg/gif/webp"));

        if (string.IsNullOrWhiteSpace(mime) || mime == "application/octet-stream")
            mime = GuessAvatarMimeFromExt(ext);
        if (!mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持图片上传"));

        var usernameLower = (user.Username ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(usernameLower))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "用户数据异常：username 为空"));

        var avatarFileName = $"{usernameLower}.{ext}".ToLowerInvariant();
        var (ok, err) = ValidateAvatarFileName(avatarFileName);
        if (!ok)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "头像文件名不合法"));

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }
        if (bytes.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));

        var objectKey = $"{AvatarUrlBuilder.AvatarPathPrefix}/{avatarFileName}".ToLowerInvariant();

        if (_assetStorage is not TencentCosStorage cos)
            return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "资产存储未配置为 TencentCosStorage"));

        await cos.UploadBytesAsync(objectKey, bytes, mime, ct);

        var now = DateTime.UtcNow;
        var update = Builders<User>.Update.Set(u => u.AvatarFileName, avatarFileName);
        await _db.Users.UpdateOneAsync(u => u.UserId == currentUserId, update, cancellationToken: ct);

        user.AvatarFileName = avatarFileName;
        var avatarUrl = BuildAvatarUrl(user);

        _logger.LogInformation("User uploaded own avatar. userId={UserId} file={File} size={Size}",
            currentUserId, avatarFileName, bytes.Length);

        return Ok(ApiResponse<UserAvatarUploadResponse>.Ok(new UserAvatarUploadResponse
        {
            UserId = currentUserId,
            AvatarFileName = avatarFileName,
            AvatarUrl = avatarUrl,
            UpdatedAt = now
        }));
    }

    /// <summary>
    /// 更新当前用户自己的头像文件名（仅更新数据库字段，不上传文件）
    /// </summary>
    [HttpPut("avatar")]
    public async Task<IActionResult> UpdateMyAvatar([FromBody] UpdateMyAvatarRequest request, CancellationToken ct)
    {
        var currentUserId = GetCurrentUserId();
        if (string.IsNullOrWhiteSpace(currentUserId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未登录"));

        var user = await _db.Users.Find(u => u.UserId == currentUserId).FirstOrDefaultAsync(ct);
        if (user == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));

        var fileName = (request?.AvatarFileName ?? string.Empty).Trim();
        fileName = string.IsNullOrWhiteSpace(fileName) ? null : fileName.ToLowerInvariant();

        var (ok, err) = ValidateAvatarFileName(fileName);
        if (!ok) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "头像文件名不合法"));

        var updateDef = Builders<User>.Update.Set(u => u.AvatarFileName, fileName);
        await _db.Users.UpdateOneAsync(u => u.UserId == currentUserId, updateDef, cancellationToken: ct);

        user.AvatarFileName = fileName;
        var avatarUrl = BuildAvatarUrl(user);

        return Ok(ApiResponse<UserAvatarUploadResponse>.Ok(new UserAvatarUploadResponse
        {
            UserId = currentUserId,
            AvatarFileName = fileName,
            AvatarUrl = avatarUrl,
            UpdatedAt = DateTime.UtcNow
        }));
    }
}

public class UpdateMyAvatarRequest
{
    public string? AvatarFileName { get; set; }
}
