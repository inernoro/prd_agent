using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Json;
using PrdAgent.Api.Services;
using PrdAgent.Api.Extensions;
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
    private const string ProfileAvatarRunAppKey = "profile-avatar";
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

    private string GetCurrentUserId() => this.GetRequiredUserId();

    private bool HasPermission(string permission)
    {
        var permissions = User.FindAll("permissions").Select(claim => claim.Value).ToHashSet(StringComparer.Ordinal);
        return permissions.Contains(permission) || permissions.Contains(AdminPermissionCatalog.Super);
    }

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

    private static string BuildVersionedAvatarFileName(string userId, string ext, ReadOnlySpan<byte> bytes)
    {
        var ownerHash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes((userId ?? string.Empty).Trim())))
            .ToLowerInvariant()[..12];
        var contentHash = Convert.ToHexString(SHA256.HashData(bytes))
            .ToLowerInvariant()[..24];
        return $"u-{ownerHash}-{contentHash}.{ext}";
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

    private static object BuildAvatarGenerationFailure(ImageGenRunStatus status)
    {
        if (status == ImageGenRunStatus.Cancelled)
        {
            return new
            {
                status = "cancelled",
                stage = "生成已取消",
                errorCode = "AVATAR_GENERATION_CANCELLED",
                errorMessage = "头像生成已取消，可以修改描述后重新生成。"
            };
        }

        return new
        {
            status = "failed",
            stage = "生成未完成",
            errorCode = "AVATAR_GENERATION_FAILED",
            errorMessage = "头像生成暂时未完成，请稍后重试；如持续出现，请重新上传一张清晰头像。"
        };
    }

    private static object BuildAvatarGenerationAccepted(ImageGenRun run)
    {
        var status = run.Status switch
        {
            ImageGenRunStatus.Completed => "completed",
            ImageGenRunStatus.Failed => "failed",
            ImageGenRunStatus.Cancelled => "cancelled",
            ImageGenRunStatus.Running => "running",
            _ => "queued"
        };
        var stage = status switch
        {
            "completed" => "生成完成",
            "failed" => "生成未完成",
            "cancelled" => "生成已取消",
            "running" => "正在生成头像",
            _ => "正在排队"
        };
        return new { runId = run.Id, status, stage };
    }

    private static string BuildAvatarGenerationRunId(string userId, string idempotencyKey)
    {
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{ProfileAvatarRunAppKey}\0{userId.Trim()}\0{idempotencyKey.Trim()}"))).ToLowerInvariant();
        return $"avatar-{fingerprint[..32]}";
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

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }
        if (bytes.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));

        var avatarFileName = BuildVersionedAvatarFileName(currentUserId, ext, bytes);

        var objectKey = $"{AvatarUrlBuilder.AvatarPathPrefix}/{avatarFileName}".ToLowerInvariant();

        await _assetStorage.UploadToKeyAsync(objectKey, bytes, mime, ct);

        var now = DateTime.UtcNow;
        var update = Builders<User>.Update.Set(u => u.AvatarFileName, avatarFileName);
        await _db.Users.UpdateOneAsync(u => u.UserId == currentUserId, update, cancellationToken: ct);

        user.AvatarFileName = avatarFileName;
        var avatarUrl = AvatarUrlBuilder.BuildFresh(_cfg, user);

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
    /// 创建本人头像 AI 编辑任务。任务由后台 Worker 执行，不受本次 HTTP 请求断开影响。
    /// </summary>
    [HttpPost("avatar/generation-runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> CreateAvatarGenerationRun(
        [FromBody] CreateAvatarGenerationRunRequest request,
        CancellationToken ct)
    {
        if (!HasPermission(AdminPermissionCatalog.VisualAgentUse))
        {
            return StatusCode(
                StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(
                    ErrorCodes.PERMISSION_DENIED,
                    "当前账号没有视觉创作权限，请联系管理员开通后重试。"));
        }

        var currentUserId = GetCurrentUserId();
        var rawIdempotencyKey = (Request.Headers["Idempotency-Key"].FirstOrDefault() ?? string.Empty).Trim();
        if (rawIdempotencyKey.Length > 160) rawIdempotencyKey = rawIdempotencyKey[..160];
        var idempotencyKey = string.IsNullOrWhiteSpace(rawIdempotencyKey)
            ? string.Empty
            : DeploymentScope.ScopeIdempotencyKey($"{ProfileAvatarRunAppKey}::{rawIdempotencyKey}");
        if (!string.IsNullOrWhiteSpace(idempotencyKey))
        {
            var existingRun = await _db.ImageGenRuns
                .Find(x => x.OwnerAdminId == currentUserId
                           && x.AppKey == ProfileAvatarRunAppKey
                           && x.IdempotencyKey == idempotencyKey)
                .FirstOrDefaultAsync(ct);
            if (existingRun != null)
            {
                PrdAgent.Api.Filters.ActivityLogActionFilter.Suppress(HttpContext);
                return Ok(ApiResponse<object>.Ok(BuildAvatarGenerationAccepted(existingRun)));
            }
        }

        var prompt = (request?.Prompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(prompt))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "请描述想怎么修改头像"));
        if (prompt.Length > 500)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "头像修改描述不能超过 500 字"));

        var user = await _db.Users.Find(u => u.UserId == currentUserId).FirstOrDefaultAsync(ct);
        if (user == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));

        var avatarFileName = (user.AvatarFileName ?? string.Empty).Trim().ToLowerInvariant();
        var (validFileName, fileNameError) = ValidateAvatarFileName(avatarFileName);
        if (!validFileName)
        {
            _logger.LogWarning(
                "Current avatar file name is invalid. userId={UserId} reason={Reason}",
                currentUserId,
                fileNameError);
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.INVALID_FORMAT,
                "当前头像不可编辑，请先上传一张新的头像。"));
        }
        if (string.IsNullOrWhiteSpace(avatarFileName))
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.CONTENT_EMPTY,
                "当前没有可编辑的头像，请先上传一张图片。"));
        }

        var avatarKey = $"{AvatarUrlBuilder.AvatarPathPrefix}/{avatarFileName}".ToLowerInvariant();
        var avatarBytes = await _assetStorage.TryDownloadBytesAsync(avatarKey, CancellationToken.None);
        if (avatarBytes == null || avatarBytes.Length == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(
                "AVATAR_SOURCE_UNAVAILABLE",
                "当前头像暂时无法读取，请重新上传一张图片后再生成。"));
        }
        if (avatarBytes.Length > MaxAvatarUploadBytes)
        {
            return StatusCode(
                StatusCodes.Status413PayloadTooLarge,
                ApiResponse<object>.Fail(
                    ErrorCodes.DOCUMENT_TOO_LARGE,
                    "当前头像文件过大，请上传一张不超过 5MB 的图片。"));
        }

        var ext = NormalizeAvatarImageExt(Path.GetExtension(avatarFileName));
        if (ext == null)
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.INVALID_FORMAT,
                "当前头像格式不受支持，请重新上传 png、jpg、gif 或 webp 图片。"));
        }

        var sourceAsset = await _assetStorage.SaveAsync(
            avatarBytes,
            GuessAvatarMimeFromExt(ext),
            CancellationToken.None,
            domain: AppDomainPaths.DomainVisualAgent,
            type: AppDomainPaths.TypeImg,
            fileName: avatarFileName,
            extensionHint: $".{ext}");

        var run = new ImageGenRun
        {
            // 幂等请求使用确定性 _id：即使 DBA 唯一索引尚未完成迁移，并发插入也由 Mongo 主键唯一性兜底。
            Id = string.IsNullOrWhiteSpace(idempotencyKey)
                ? Guid.NewGuid().ToString("N")
                : BuildAvatarGenerationRunId(currentUserId, idempotencyKey),
            OwnerAdminId = currentUserId,
            Status = ImageGenRunStatus.ScopedQueued,
            DeploymentSlug = DeploymentScope.Current,
            ModelResolutionType = null,
            Size = "1024x1024",
            ResponseFormat = "b64_json",
            MaxConcurrency = 1,
            Items = new List<ImageGenRunPlanItem>
            {
                new()
                {
                    Prompt = $"基于参考头像进行编辑，保持人物身份和主要五官特征，输出适合作为账号头像的正方形构图。用户要求：{prompt}",
                    DisplayPrompt = prompt,
                    Count = 1,
                    Size = "1024x1024"
                }
            },
            Total = 1,
            AppKey = ProfileAvatarRunAppKey,
            AppCallerCode = AppCallerRegistry.VisualAgent.Image.Img2Img,
            InitImageAssetSha256 = sourceAsset.Sha256,
            IdempotencyKey = string.IsNullOrWhiteSpace(idempotencyKey) ? null : idempotencyKey,
            CreatedAt = DateTime.UtcNow
        };

        try
        {
            await _db.ImageGenRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);
        }
        catch (MongoWriteException exception) when (
            exception.WriteError?.Category == ServerErrorCategory.DuplicateKey
            && !string.IsNullOrWhiteSpace(idempotencyKey))
        {
            var existingRun = await _db.ImageGenRuns
                .Find(x => x.OwnerAdminId == currentUserId
                           && x.AppKey == ProfileAvatarRunAppKey
                           && x.IdempotencyKey == idempotencyKey)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (existingRun != null)
            {
                PrdAgent.Api.Filters.ActivityLogActionFilter.Suppress(HttpContext);
                return Ok(ApiResponse<object>.Ok(BuildAvatarGenerationAccepted(existingRun)));
            }
            throw;
        }
        _logger.LogInformation(
            "Profile avatar generation run created. userId={UserId} runId={RunId}",
            currentUserId,
            run.Id);

        return Ok(ApiResponse<object>.Ok(new
        {
            runId = run.Id,
            status = "queued",
            stage = "正在排队"
        }));
    }

    /// <summary>
    /// 查询本人头像 AI 编辑任务。只返回用户可理解状态，不透传模型或上游诊断。
    /// </summary>
    [HttpGet("avatar/generation-runs/{runId}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetAvatarGenerationRun(string runId, CancellationToken ct)
    {
        var currentUserId = GetCurrentUserId();
        var normalizedRunId = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalizedRunId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务编号不能为空"));

        var run = await _db.ImageGenRuns
            .Find(x => x.Id == normalizedRunId
                       && x.OwnerAdminId == currentUserId
                       && x.AppKey == ProfileAvatarRunAppKey)
            .FirstOrDefaultAsync(ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail("AVATAR_GENERATION_NOT_FOUND", "没有找到这次头像生成任务，请重新生成。"));

        if (run.Status is ImageGenRunStatus.Failed or ImageGenRunStatus.Cancelled)
            return Ok(ApiResponse<object>.Ok(BuildAvatarGenerationFailure(run.Status)));

        if (run.Status != ImageGenRunStatus.Completed)
        {
            var stage = run.Status == ImageGenRunStatus.Running ? "正在生成头像" : "正在排队";
            return Ok(ApiResponse<object>.Ok(new
            {
                status = run.Status == ImageGenRunStatus.Running ? "running" : "queued",
                stage,
                done = run.Done,
                total = Math.Max(1, run.Total)
            }));
        }

        var requestId = $"{run.Id}-0-0";
        var artifact = await _db.UploadArtifacts
            .Find(x => x.CreatedByAdminId == currentUserId
                       && x.Kind == "output_image"
                       && x.RequestId == requestId)
            .SortByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);
        if (artifact == null
            || string.IsNullOrWhiteSpace(artifact.CosUrl)
            || artifact.Sha256.Length != 64)
        {
            _logger.LogWarning(
                "Profile avatar run completed without usable artifact. userId={UserId} runId={RunId}",
                currentUserId,
                run.Id);
            return Ok(ApiResponse<object>.Ok(new
            {
                status = "failed",
                stage = "生成未完成",
                errorCode = "AVATAR_RESULT_UNAVAILABLE",
                errorMessage = "头像已经生成，但预览暂时无法读取，请稍后重新生成。"
            }));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            status = "completed",
            stage = "生成完成",
            previewUrl = artifact.CosUrl,
            assetSha256 = artifact.Sha256
        }));
    }

    /// <summary>
    /// 将当前用户刚生成的视觉资产设为自己的头像。只接受本人创建的生图产物。
    /// </summary>
    [HttpPost("avatar/apply-generated")]
    [ProducesResponseType(typeof(ApiResponse<UserAvatarUploadResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ApplyGeneratedAvatar([FromBody] ApplyGeneratedAvatarRequest request, CancellationToken ct)
    {
        var currentUserId = GetCurrentUserId();
        var sha256 = (request?.AssetSha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (sha256.Length != 64 || !Regex.IsMatch(sha256, "^[0-9a-f]{64}$"))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "assetSha256 格式不正确"));

        var user = await _db.Users.Find(u => u.UserId == currentUserId).FirstOrDefaultAsync(ct);
        if (user == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));

        var artifact = await _db.UploadArtifacts
            .Find(x => x.CreatedByAdminId == currentUserId && x.Kind == "output_image" && x.Sha256 == sha256)
            .SortByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);
        if (artifact == null)
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权使用该生成图片"));

        var found = await _assetStorage.TryReadByShaAsync(
            sha256,
            ct,
            domain: AppDomainPaths.DomainVisualAgent,
            type: AppDomainPaths.TypeImg);
        if (found == null || found.Value.bytes.Length == 0)
            return NotFound(ApiResponse<object>.Fail("ASSET_NOT_FOUND", "生成图片不存在或不可用"));
        if (found.Value.bytes.Length > MaxAvatarUploadBytes)
            return StatusCode(StatusCodes.Status413PayloadTooLarge,
                ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "生成图片过大，无法作为头像"));

        var mime = string.IsNullOrWhiteSpace(found.Value.mime) ? artifact.Mime : found.Value.mime;
        var ext = GuessAvatarImageExtFromMime(mime);
        if (ext == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "生成图片格式不受支持"));

        var avatarFileName = BuildVersionedAvatarFileName(currentUserId, ext, found.Value.bytes);
        var (ok, err) = ValidateAvatarFileName(avatarFileName);
        if (!ok)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "头像文件名不合法"));

        var objectKey = $"{AvatarUrlBuilder.AvatarPathPrefix}/{avatarFileName}".ToLowerInvariant();
        await _assetStorage.UploadToKeyAsync(objectKey, found.Value.bytes, mime, ct);
        await _db.Users.UpdateOneAsync(
            u => u.UserId == currentUserId,
            Builders<User>.Update.Set(u => u.AvatarFileName, avatarFileName),
            cancellationToken: ct);

        user.AvatarFileName = avatarFileName;
        var now = DateTime.UtcNow;
        var avatarUrl = AvatarUrlBuilder.BuildFresh(_cfg, user);
        _logger.LogInformation(
            "User applied generated avatar. userId={UserId} file={File} assetSha256={AssetSha256}",
            currentUserId,
            avatarFileName,
            sha256);

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
        var avatarUrl = AvatarUrlBuilder.BuildFresh(_cfg, user);

        return Ok(ApiResponse<UserAvatarUploadResponse>.Ok(new UserAvatarUploadResponse
        {
            UserId = currentUserId,
            AvatarFileName = fileName,
            AvatarUrl = avatarUrl,
            UpdatedAt = DateTime.UtcNow
        }));
    }

    /// <summary>
    /// 更新当前用户在个人公开页上展示的自我介绍 / 背景主题。
    /// 传 null 即清空。Bio 最多 500 字；Background 是前端主题 key（不校验枚举，允许未来无迁移扩展）。
    /// </summary>
    [HttpPatch("public-page")]
    public async Task<IActionResult> UpdatePublicPage([FromBody] UpdatePublicPageRequest request, CancellationToken ct)
    {
        var currentUserId = GetCurrentUserId();
        if (string.IsNullOrWhiteSpace(currentUserId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未登录"));

        var user = await _db.Users.Find(u => u.UserId == currentUserId).FirstOrDefaultAsync(ct);
        if (user == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));

        var bio = request?.Bio?.Trim();
        if (bio != null && bio.Length > 500)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "自我介绍不能超过 500 字"));
        var bg = request?.ProfileBackground?.Trim();
        if (bg != null && bg.Length > 64)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "背景主题 key 过长"));

        var update = Builders<User>.Update
            .Set(u => u.Bio, string.IsNullOrEmpty(bio) ? null : bio)
            .Set(u => u.ProfileBackground, string.IsNullOrEmpty(bg) ? null : bg);
        await _db.Users.UpdateOneAsync(u => u.UserId == currentUserId, update, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            userId = currentUserId,
            bio = string.IsNullOrEmpty(bio) ? null : bio,
            profileBackground = string.IsNullOrEmpty(bg) ? null : bg,
        }));
    }
}

public class UpdateMyAvatarRequest
{
    public string? AvatarFileName { get; set; }
}

public class ApplyGeneratedAvatarRequest
{
    public string AssetSha256 { get; set; } = string.Empty;
}

public class CreateAvatarGenerationRunRequest
{
    public string Prompt { get; set; } = string.Empty;
}

public class UpdatePublicPageRequest
{
    public string? Bio { get; set; }
    public string? ProfileBackground { get; set; }
}
