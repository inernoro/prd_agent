using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Json;
using PrdAgent.Api.Services;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using SixLabors.ImageSharp;

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
    private const string ProfileAvatarRunAppKey = ProfileAvatarGenerationCleanupService.AppKey;
    private readonly MongoDbContext _db;
    private readonly ILogger<ProfileController> _logger;
    private readonly IConfiguration _cfg;
    private readonly IAssetStorage _assetStorage;
    private readonly IRunEventStore _runStore;
    private readonly ProfileAvatarGenerationCleanupService _avatarGenerationCleanup;
    private static readonly JsonSerializerOptions AvatarSseJsonOptions = new(JsonSerializerDefaults.Web);

    private const long MaxAvatarUploadBytes = 5 * 1024 * 1024; // 5MB
    private const int MaxAvatarDimension = 8192;
    private const long MaxAvatarPixels = 16_777_216;
    private const int MaxAvatarFrames = 120;

    public ProfileController(
        MongoDbContext db,
        ILogger<ProfileController> logger,
        IConfiguration cfg,
        IAssetStorage assetStorage,
        IRunEventStore runStore,
        ProfileAvatarGenerationCleanupService avatarGenerationCleanup)
    {
        _db = db;
        _logger = logger;
        _cfg = cfg;
        _assetStorage = assetStorage;
        _runStore = runStore;
        _avatarGenerationCleanup = avatarGenerationCleanup;
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

    internal static (bool ok, string? ext, string? mime) ValidateAvatarImageBytes(
        byte[] bytes,
        string? requestedExt,
        string? claimedMime)
    {
        if (bytes.Length == 0)
            return (false, null, null);

        try
        {
            var imageInfo = Image.Identify(bytes);
            var format = imageInfo.Metadata.DecodedImageFormat;
            if (format == null)
                return (false, null, null);

            var frameCount = Math.Max(1, imageInfo.FrameMetadataCollection.Count);
            if (!HasSafeAvatarImageDimensions(imageInfo.Width, imageInfo.Height, frameCount))
                return (false, null, null);

            using var image = Image.Load(bytes);
            if (image.Width != imageInfo.Width
                || image.Height != imageInfo.Height
                || image.Frames.Count != frameCount)
                return (false, null, null);

            var actualExt = GuessAvatarImageExtFromMime(format.DefaultMimeType);
            if (actualExt == null)
                return (false, null, null);

            var normalizedRequestedExt = NormalizeAvatarImageExt(requestedExt);
            if (!string.IsNullOrWhiteSpace(requestedExt) && normalizedRequestedExt == null)
                return (false, null, null);
            if (normalizedRequestedExt != null
                && !string.Equals(normalizedRequestedExt, actualExt, StringComparison.Ordinal))
                return (false, null, null);

            var normalizedClaimedMime = (claimedMime ?? string.Empty).Trim().ToLowerInvariant();
            if (!string.IsNullOrWhiteSpace(normalizedClaimedMime)
                && normalizedClaimedMime != "application/octet-stream"
                && !string.Equals(
                    GuessAvatarImageExtFromMime(normalizedClaimedMime),
                    actualExt,
                    StringComparison.Ordinal))
            {
                return (false, null, null);
            }

            return (true, actualExt, GuessAvatarMimeFromExt(actualExt));
        }
        catch
        {
            return (false, null, null);
        }
    }

    internal static bool HasSafeAvatarImageDimensions(int width, int height, int frameCount)
    {
        if (width <= 0 || height <= 0 || frameCount <= 0)
            return false;
        if (width > MaxAvatarDimension || height > MaxAvatarDimension || frameCount > MaxAvatarFrames)
            return false;

        var pixels = (long)width * height;
        return pixels <= MaxAvatarPixels
            && pixels * frameCount <= MaxAvatarPixels;
    }

    private static string BuildVersionedAvatarFileName(string userId, string ext, ReadOnlySpan<byte> bytes)
    {
        var contentHash = Convert.ToHexString(SHA256.HashData(bytes))
            .ToLowerInvariant()[..24];
        return $"{ProfileAvatarObjectCleanupPolicy.BuildOwnerPrefix(userId)}{contentHash}.{ext}";
    }

    private async Task<User?> ReplaceAvatarFileNameAsync(
        string userId,
        string? avatarFileName,
        CancellationToken ct)
    {
        return await _db.Users.FindOneAndUpdateAsync<User, User>(
            u => u.UserId == userId,
            Builders<User>.Update.Set(u => u.AvatarFileName, avatarFileName),
            new FindOneAndUpdateOptions<User, User> { ReturnDocument = ReturnDocument.Before },
            ct);
    }

    private async Task DeleteSupersededAvatarAsync(
        string userId,
        string? previousFileName,
        string? currentFileName)
    {
        await _avatarGenerationCleanup.TrackAndTryDeleteSupersededAvatarAsync(
            userId,
            previousFileName,
            currentFileName,
            CancellationToken.None);
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

    private static object BuildAvatarGenerationFailure(ImageGenRunStatus status, string? itemErrorCode = null)
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

        var failure = MapAvatarGenerationFailure(itemErrorCode);
        return new
        {
            status = "failed",
            stage = "生成未完成",
            errorCode = failure.errorCode,
            errorMessage = failure.errorMessage
        };
    }

    private static (string errorCode, string errorMessage) MapAvatarGenerationFailure(string? itemErrorCode)
    {
        return (itemErrorCode ?? string.Empty).Trim().ToUpperInvariant() switch
        {
            "IMAGE_GEN_REQUEST_REJECTED" or "CONTENT_REJECTED" or "INVALID_FORMAT" => (
                "IMAGE_GEN_REQUEST_REJECTED",
                "这次描述或参考图未通过检查，请调整描述或更换参考图后重试。"),
            "LLM_QUOTA_EXCEEDED" or "QUOTA_EXCEEDED" => (
                "LLM_QUOTA_EXCEEDED",
                "当前可用额度不足，请联系管理员补充额度或切换可用配置后重试。"),
            "RATE_LIMITED" => (
                "RATE_LIMITED",
                "当前生图请求较多，请稍后重试。"),
            "IMAGE_GEN_TIMEOUT" => (
                "IMAGE_GEN_TIMEOUT",
                "图片生成等待超时，请稍后查看结果或重新生成。"),
            "IMAGE_GEN_UNAVAILABLE" => (
                "IMAGE_GEN_UNAVAILABLE",
                "当前生图服务暂时不可用，请稍后重新生成。"),
            _ => (
                "AVATAR_GENERATION_FAILED",
                "头像生成暂时未完成，请稍后重试；如持续出现，请重新上传一张清晰头像。")
        };
    }

    private static object BuildAvatarGenerationAccepted(ImageGenRun run)
    {
        var status = run.Status switch
        {
            ImageGenRunStatus.Completed => "completed",
            ImageGenRunStatus.Failed => "failed",
            ImageGenRunStatus.Cancelled when run.EndedAt != null => "cancelled",
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

    private async Task<(object payload, bool terminal)> BuildAvatarGenerationStatusAsync(
        ImageGenRun run,
        string currentUserId,
        CancellationToken ct)
    {
        if (run.Status == ImageGenRunStatus.Failed
            || (run.Status == ImageGenRunStatus.Cancelled && run.EndedAt != null))
        {
            string? itemErrorCode = null;
            if (run.Status == ImageGenRunStatus.Failed)
            {
                var failedItem = await _db.ImageGenRunItems
                    .Find(x => x.RunId == run.Id
                               && x.OwnerAdminId == currentUserId
                               && x.Status == ImageGenRunItemStatus.Error)
                    .SortByDescending(x => x.EndedAt)
                    .FirstOrDefaultAsync(ct);
                itemErrorCode = failedItem?.ErrorCode;
            }
            return (BuildAvatarGenerationFailure(run.Status, itemErrorCode), true);
        }

        if (run.Status != ImageGenRunStatus.Completed)
        {
            var stage = run.Status == ImageGenRunStatus.Running ? "正在生成头像" : "正在排队";
            return (new
            {
                status = run.Status == ImageGenRunStatus.Running ? "running" : "queued",
                stage,
                done = run.Done,
                total = Math.Max(1, run.Total)
            }, false);
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
            return (new
            {
                status = "failed",
                stage = "生成未完成",
                errorCode = "AVATAR_RESULT_UNAVAILABLE",
                errorMessage = "头像已经生成，但预览暂时无法读取，请稍后重新生成。"
            }, true);
        }

        return (new
        {
            status = "completed",
            stage = "生成完成",
            previewUrl = artifact.CosUrl,
            assetSha256 = artifact.Sha256
        }, true);
    }

    private async Task WriteAvatarStatusSseAsync(string? id, string dataJson, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(id))
        {
            await Response.WriteAsync($"id: {id}\n", ct);
        }
        await Response.WriteAsync("event: status\n", ct);
        await Response.WriteAsync($"data: {dataJson}\n\n", ct);
        await Response.Body.FlushAsync(ct);
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

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }
        if (bytes.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "file 内容为空"));

        var validation = ValidateAvatarImageBytes(
            bytes,
            Path.GetExtension(file.FileName ?? string.Empty),
            file.ContentType);
        if (!validation.ok || validation.ext == null || validation.mime == null)
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.INVALID_FORMAT,
                "图片内容损坏，或实际格式与文件名、类型不一致，请重新选择图片后上传。"));
        }
        var ext = validation.ext;
        var mime = validation.mime;

        var avatarFileName = BuildVersionedAvatarFileName(currentUserId, ext, bytes);

        var objectKey = $"{AvatarUrlBuilder.AvatarPathPrefix}/{avatarFileName}".ToLowerInvariant();

        User? previousUser;
        await using (var avatarMutationLease = await VideoAssetMutationLease.AcquireAsync(
                         _db,
                         ProfileAvatarObjectCleanupPolicy.BuildUserMutationLeaseKey(currentUserId),
                         ct))
        {
            await _avatarGenerationCleanup.TrackPendingAvatarObjectAsync(
                currentUserId,
                avatarFileName,
                CancellationToken.None);
            await _assetStorage.UploadToKeyAsync(objectKey, bytes, mime, ct);
            previousUser = await ReplaceAvatarFileNameAsync(currentUserId, avatarFileName, ct);
            if (previousUser != null)
            {
                await _avatarGenerationCleanup.CancelPendingAvatarObjectCleanupAsync(
                    currentUserId,
                    avatarFileName,
                    CancellationToken.None);
            }
        }
        if (previousUser == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        await DeleteSupersededAvatarAsync(currentUserId, previousUser?.AvatarFileName, avatarFileName);

        var now = DateTime.UtcNow;
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

    private static string? TryGetAvatarGenerationRunId(string? requestId)
    {
        const string suffix = "-0-0";
        var normalized = (requestId ?? string.Empty).Trim();
        return normalized.EndsWith(suffix, StringComparison.Ordinal) && normalized.Length > suffix.Length
            ? normalized[..^suffix.Length]
            : null;
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
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.AVATAR_PROMPT_TOO_LONG, "头像修改描述不能超过 500 字"));

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

        var sourceSha256 = Convert.ToHexString(SHA256.HashData(avatarBytes)).ToLowerInvariant();
        var run = new ImageGenRun
        {
            // 幂等请求使用确定性 _id：即使 DBA 唯一索引尚未完成迁移，并发插入也由 Mongo 主键唯一性兜底。
            Id = string.IsNullOrWhiteSpace(idempotencyKey)
                ? Guid.NewGuid().ToString("N")
                : BuildAvatarGenerationRunId(currentUserId, idempotencyKey),
            OwnerAdminId = currentUserId,
            // 先以不可认领状态持久化清理意图，再写对象存储，最后原子激活队列。
            // 若保存或激活失败，终态 run 仍能让清理服务发现并回收可能已写入的源对象。
            Status = ImageGenRunStatus.Cancelled,
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
            InitImageAssetSha256 = sourceSha256,
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

        await using var sourceAssetLease = await VideoAssetMutationLease.AcquireAsync(
            _db,
            $"generated-image:{sourceSha256}",
            CancellationToken.None);
        try
        {
            await _assetStorage.SaveAsync(
                avatarBytes,
                GuessAvatarMimeFromExt(ext),
                CancellationToken.None,
                domain: AppDomainPaths.DomainVisualAgent,
                type: AppDomainPaths.TypeImg,
                fileName: avatarFileName,
                extensionHint: $".{ext}");

            var activation = await _db.ImageGenRuns.UpdateOneAsync(
                x => x.Id == run.Id
                     && x.OwnerAdminId == currentUserId
                     && x.AppKey == ProfileAvatarRunAppKey
                     && x.Status == ImageGenRunStatus.Cancelled
                     && x.EndedAt == null,
                Builders<ImageGenRun>.Update.Set(x => x.Status, ImageGenRunStatus.ScopedQueued),
                cancellationToken: CancellationToken.None);
            if (activation.ModifiedCount != 1)
            {
                throw new InvalidOperationException("Avatar generation run could not be activated.");
            }
            run.Status = ImageGenRunStatus.ScopedQueued;
        }
        catch
        {
            try
            {
                await _db.ImageGenRuns.UpdateOneAsync(
                    x => x.Id == run.Id && x.Status == ImageGenRunStatus.Cancelled,
                    Builders<ImageGenRun>.Update.Set(x => x.EndedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
            }
            catch (Exception cleanupIntentException)
            {
                _logger.LogError(
                    cleanupIntentException,
                    "Avatar source cleanup intent finalization failed. userId={UserId} runId={RunId}",
                    currentUserId,
                    run.Id);
            }
            _avatarGenerationCleanup.QueueRunCleanup(run.Id, currentUserId);
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

        var state = await BuildAvatarGenerationStatusAsync(run, currentUserId, ct);
        return Ok(ApiResponse<object>.Ok(state.payload));
    }

    /// <summary>
    /// 流式订阅本人头像生成进度。只推送用户可理解状态，不暴露模型、供应商或上游诊断。
    /// </summary>
    [HttpGet("avatar/generation-runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamAvatarGenerationRun(
        string runId,
        [FromQuery] long afterSeq = 0,
        CancellationToken ct = default)
    {
        var currentUserId = GetCurrentUserId();
        var normalizedRunId = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalizedRunId))
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            await Response.WriteAsJsonAsync(
                ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务编号不能为空"),
                cancellationToken: ct);
            return;
        }

        var run = await _db.ImageGenRuns
            .Find(x => x.Id == normalizedRunId
                       && x.OwnerAdminId == currentUserId
                       && x.AppKey == ProfileAvatarRunAppKey)
            .FirstOrDefaultAsync(ct);
        if (run == null)
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            await Response.WriteAsJsonAsync(
                ApiResponse<object>.Fail("AVATAR_GENERATION_NOT_FOUND", "没有找到这次头像生成任务，请重新生成。"),
                cancellationToken: ct);
            return;
        }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";
        afterSeq = Math.Max(0, afterSeq);

        try
        {
            var state = await BuildAvatarGenerationStatusAsync(run, currentUserId, ct);
            var lastStateJson = JsonSerializer.Serialize(state.payload, AvatarSseJsonOptions);
            await WriteAvatarStatusSseAsync(id: null, lastStateJson, ct);
            if (state.terminal) return;

            var lastKeepAliveAt = DateTime.UtcNow;
            var nextReconcileAt = DateTime.UtcNow.AddSeconds(10);
            while (!ct.IsCancellationRequested)
            {
                var events = await _runStore.GetEventsAsync(
                    RunKinds.ImageGen,
                    normalizedRunId,
                    afterSeq,
                    limit: 120,
                    ct);
                if (events.Count > 0)
                {
                    afterSeq = events[^1].Seq;
                }

                var now = DateTime.UtcNow;
                if (events.Count > 0 || now >= nextReconcileAt)
                {
                    run = await _db.ImageGenRuns
                        .Find(x => x.Id == normalizedRunId
                                   && x.OwnerAdminId == currentUserId
                                   && x.AppKey == ProfileAvatarRunAppKey)
                        .FirstOrDefaultAsync(ct);
                    if (run == null) return;

                    state = await BuildAvatarGenerationStatusAsync(run, currentUserId, ct);
                    var stateJson = JsonSerializer.Serialize(state.payload, AvatarSseJsonOptions);
                    if (!string.Equals(stateJson, lastStateJson, StringComparison.Ordinal))
                    {
                        await WriteAvatarStatusSseAsync(afterSeq > 0 ? afterSeq.ToString() : null, stateJson, ct);
                        lastStateJson = stateJson;
                        lastKeepAliveAt = now;
                    }
                    if (state.terminal) return;
                    nextReconcileAt = now.AddSeconds(10);
                }

                if ((now - lastKeepAliveAt).TotalSeconds >= 10)
                {
                    await Response.WriteAsync(": keepalive\n\n", ct);
                    await Response.Body.FlushAsync(ct);
                    lastKeepAliveAt = now;
                }
                await Task.Delay(650, ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // 浏览器关闭或切换页面时正常结束流。
        }
        catch (ObjectDisposedException)
        {
            // 浏览器或反向代理已释放响应流，属于正常断连。
        }
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

        var validation = ValidateAvatarImageBytes(
            found.Value.bytes,
            null,
            string.IsNullOrWhiteSpace(found.Value.mime) ? artifact.Mime : found.Value.mime);
        if (!validation.ok || validation.ext == null || validation.mime == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "生成图片格式不受支持或内容损坏"));
        var ext = validation.ext;
        var mime = validation.mime;

        var avatarFileName = BuildVersionedAvatarFileName(currentUserId, ext, found.Value.bytes);
        var (ok, err) = ValidateAvatarFileName(avatarFileName);
        if (!ok)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "头像文件名不合法"));

        var objectKey = $"{AvatarUrlBuilder.AvatarPathPrefix}/{avatarFileName}".ToLowerInvariant();
        User? previousUser;
        await using (var avatarMutationLease = await VideoAssetMutationLease.AcquireAsync(
                         _db,
                         ProfileAvatarObjectCleanupPolicy.BuildUserMutationLeaseKey(currentUserId),
                         ct))
        {
            await _avatarGenerationCleanup.TrackPendingAvatarObjectAsync(
                currentUserId,
                avatarFileName,
                CancellationToken.None);
            await _assetStorage.UploadToKeyAsync(objectKey, found.Value.bytes, mime, ct);
            previousUser = await ReplaceAvatarFileNameAsync(currentUserId, avatarFileName, ct);
            if (previousUser != null)
            {
                await _avatarGenerationCleanup.CancelPendingAvatarObjectCleanupAsync(
                    currentUserId,
                    avatarFileName,
                    CancellationToken.None);
            }
        }
        if (previousUser == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        await DeleteSupersededAvatarAsync(currentUserId, previousUser?.AvatarFileName, avatarFileName);

        var sourceRunId = TryGetAvatarGenerationRunId(artifact.RequestId);
        if (sourceRunId != null)
        {
            _avatarGenerationCleanup.QueueRunCleanup(sourceRunId, currentUserId);
        }

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

        await using var avatarMutationLease = await VideoAssetMutationLease.AcquireAsync(
            _db,
            ProfileAvatarObjectCleanupPolicy.BuildUserMutationLeaseKey(currentUserId),
            ct);
        if (!string.IsNullOrWhiteSpace(fileName))
        {
            if (!fileName.StartsWith(
                    ProfileAvatarObjectCleanupPolicy.BuildOwnerPrefix(currentUserId),
                    StringComparison.Ordinal))
            {
                return BadRequest(ApiResponse<object>.Fail(
                    ErrorCodes.INVALID_FORMAT,
                    "该头像不属于当前用户，请重新上传或生成后再试"));
            }

            var objectKey = $"{AvatarUrlBuilder.AvatarPathPrefix}/{fileName}";
            bool avatarExists;
            try
            {
                avatarExists = await _assetStorage.ExistsAsync(objectKey, ct);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Self-service avatar object validation failed. userId={UserId}", currentUserId);
                return StatusCode(
                    StatusCodes.Status503ServiceUnavailable,
                    ApiResponse<object>.Fail(
                        "AVATAR_STORAGE_UNAVAILABLE",
                        "头像存储暂时不可用，原头像未变更，请稍后重试"));
            }

            if (!avatarExists)
            {
                return NotFound(ApiResponse<object>.Fail(
                    "AVATAR_NOT_FOUND",
                    "头像文件不存在，请重新上传或生成后再试"));
            }
        }

        // 这个兼容端点只切换到已经存在的本人头像，不能在未验证新对象时删除旧对象。
        // 上传和生成应用端点在新对象落盘后负责清理被替换的旧版本。
        await ReplaceAvatarFileNameAsync(currentUserId, fileName, ct);

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
