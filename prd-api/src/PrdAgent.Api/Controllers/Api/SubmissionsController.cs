using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Claims;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 作品投稿展示（公共画廊）
/// - 所有登录用户可投稿自己的作品
/// - 公开作品列表无需特殊权限
/// </summary>
[ApiController]
[Route("api/submissions")]
[Authorize]
public class SubmissionsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public SubmissionsController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetUserId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    private string? GetUsername()
        => User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value;

    private static string ResolveDisplayName(User? user, string? claimName, string userId)
    {
        var displayName = user?.DisplayName?.Trim();
        if (!string.IsNullOrWhiteSpace(displayName)) return displayName;
        var username = user?.Username?.Trim();
        if (!string.IsNullOrWhiteSpace(username)) return username;
        var nameFromClaim = claimName?.Trim();
        if (!string.IsNullOrWhiteSpace(nameFromClaim)) return nameFromClaim;
        return userId;
    }

    /// <summary>
    /// 获取公开作品列表（支持分页 + 类型筛选）
    /// </summary>
    [HttpGet("public")]
    public async Task<IActionResult> ListPublicSubmissions(
        [FromQuery] string? contentType = null,
        [FromQuery] int skip = 0,
        [FromQuery] int limit = 20)
    {
        var userId = GetUserId();
        limit = Math.Clamp(limit, 1, 50);

        var filter = Builders<Submission>.Filter.Eq(x => x.IsPublic, true);
        if (!string.IsNullOrWhiteSpace(contentType))
            filter &= Builders<Submission>.Filter.Eq(x => x.ContentType, contentType);

        var total = await _db.Submissions.CountDocumentsAsync(filter);
        var items = await _db.Submissions
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip(skip)
            .Limit(limit)
            .ToListAsync();

        // 查询当前用户是否已点赞
        var submissionIds = items.Select(x => x.Id).ToList();
        var myLikes = await _db.SubmissionLikes
            .Find(x => x.UserId == userId && submissionIds.Contains(x.SubmissionId))
            .ToListAsync();
        var likedSet = new HashSet<string>(myLikes.Select(x => x.SubmissionId));

        var result = items.Select(x => new
        {
            x.Id,
            x.Title,
            x.ContentType,
            x.CoverUrl,
            x.CoverWidth,
            x.CoverHeight,
            x.Prompt,
            x.OwnerUserId,
            x.OwnerUserName,
            x.OwnerAvatarFileName,
            x.LikeCount,
            likedByMe = likedSet.Contains(x.Id),
            x.CreatedAt,
        });

        return Ok(ApiResponse<object>.Ok(new { total, items = result }));
    }

    /// <summary>
    /// 获取当前用户的投稿列表
    /// </summary>
    [HttpGet("mine")]
    public async Task<IActionResult> ListMySubmissions()
    {
        var userId = GetUserId();
        var items = await _db.Submissions
            .Find(x => x.OwnerUserId == userId)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 获取投稿详情（含关联的 workspace 资产列表）
    /// </summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> GetSubmissionDetail(string id)
    {
        var userId = GetUserId();
        var submission = await _db.Submissions.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "投稿不存在"));
        if (!submission.IsPublic && submission.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "该投稿未公开"));

        // 增加浏览计数（非阻塞）
        _ = _db.Submissions.UpdateOneAsync(
            x => x.Id == id,
            Builders<Submission>.Update.Inc(x => x.ViewCount, 1));

        // 查询点赞状态
        var likedByMe = await _db.SubmissionLikes
            .Find(x => x.SubmissionId == id && x.UserId == userId)
            .AnyAsync();

        // 获取关联资产
        var relatedAssets = new List<object>();
        string? articleContent = null;

        if (submission.ContentType == "visual" && !string.IsNullOrWhiteSpace(submission.WorkspaceId))
        {
            // 视觉创作：同 workspace 的其他图片
            var assets = await _db.ImageAssets
                .Find(x => x.WorkspaceId == submission.WorkspaceId)
                .SortByDescending(x => x.CreatedAt)
                .Limit(50)
                .ToListAsync();
            relatedAssets = assets.Select(a => (object)new
            {
                a.Id,
                a.Url,
                a.Width,
                a.Height,
                a.Prompt,
                a.CreatedAt,
            }).ToList();
        }
        else if (submission.ContentType == "literary" && !string.IsNullOrWhiteSpace(submission.WorkspaceId))
        {
            // 文学创作：workspace 所有配图 + 文章内容
            var workspace = await _db.ImageMasterWorkspaces
                .Find(x => x.Id == submission.WorkspaceId)
                .FirstOrDefaultAsync();
            if (workspace != null)
            {
                articleContent = workspace.ArticleContent;
            }
            var assets = await _db.ImageAssets
                .Find(x => x.WorkspaceId == submission.WorkspaceId)
                .SortBy(x => x.ArticleInsertionIndex)
                .ThenBy(x => x.CreatedAt)
                .ToListAsync();
            relatedAssets = assets.Select(a => (object)new
            {
                a.Id,
                a.Url,
                a.Width,
                a.Height,
                a.Prompt,
                a.OriginalMarkerText,
                a.ArticleInsertionIndex,
                a.CreatedAt,
            }).ToList();
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            submission = new
            {
                submission.Id,
                submission.Title,
                submission.ContentType,
                submission.CoverUrl,
                submission.CoverWidth,
                submission.CoverHeight,
                submission.Prompt,
                submission.WorkspaceId,
                submission.ImageAssetId,
                submission.OwnerUserId,
                submission.OwnerUserName,
                submission.OwnerAvatarFileName,
                submission.LikeCount,
                submission.ViewCount,
                likedByMe,
                submission.CreatedAt,
            },
            relatedAssets,
            articleContent,
        }));
    }

    /// <summary>
    /// 创建投稿（视觉创作场景：从 ImageAsset 投稿）
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> CreateSubmission([FromBody] CreateSubmissionRequest request)
    {
        var userId = GetUserId();
        var username = GetUsername();

        if (string.IsNullOrWhiteSpace(request.ContentType) ||
            (request.ContentType != "visual" && request.ContentType != "literary"))
            return BadRequest(ApiResponse<object>.Fail("INVALID_CONTENT_TYPE", "contentType 必须为 visual 或 literary"));

        // 视觉创作：从 ImageAsset 创建投稿
        if (request.ContentType == "visual")
        {
            if (string.IsNullOrWhiteSpace(request.ImageAssetId))
                return BadRequest(ApiResponse<object>.Fail("MISSING_IMAGE_ASSET", "视觉创作投稿必须提供 imageAssetId"));

            var asset = await _db.ImageAssets.Find(x => x.Id == request.ImageAssetId).FirstOrDefaultAsync();
            if (asset == null)
                return NotFound(ApiResponse<object>.Fail("IMAGE_NOT_FOUND", "图片不存在"));
            if (asset.OwnerUserId != userId)
                return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只能投稿自己的作品"));

            // 查重
            var existing = await _db.Submissions
                .Find(x => x.ImageAssetId == request.ImageAssetId)
                .FirstOrDefaultAsync();
            if (existing != null)
                return Ok(ApiResponse<object>.Ok(new { submission = existing, created = false }));

            var currentUser = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
            var displayName = ResolveDisplayName(currentUser, username, userId);

            var submission = new Submission
            {
                Title = request.Title ?? asset.Prompt?.Substring(0, Math.Min(asset.Prompt.Length, 50)) ?? "未命名作品",
                ContentType = "visual",
                CoverUrl = asset.Url,
                CoverWidth = asset.Width,
                CoverHeight = asset.Height,
                WorkspaceId = asset.WorkspaceId,
                ImageAssetId = asset.Id,
                Prompt = asset.Prompt,
                OwnerUserId = userId,
                OwnerUserName = displayName,
                OwnerAvatarFileName = currentUser?.AvatarFileName,
                IsPublic = request.IsPublic ?? true,
            };

            await _db.Submissions.InsertOneAsync(submission);
            return Ok(ApiResponse<object>.Ok(new { submission, created = true }));
        }

        // 文学创作：从 Workspace 创建投稿
        if (string.IsNullOrWhiteSpace(request.WorkspaceId))
            return BadRequest(ApiResponse<object>.Fail("MISSING_WORKSPACE", "文学创作投稿必须提供 workspaceId"));

        var workspace = await _db.ImageMasterWorkspaces
            .Find(x => x.Id == request.WorkspaceId)
            .FirstOrDefaultAsync();
        if (workspace == null)
            return NotFound(ApiResponse<object>.Fail("WORKSPACE_NOT_FOUND", "工作区不存在"));
        if (workspace.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只能投稿自己的作品"));

        // 查重（按 workspaceId）
        var existingWs = await _db.Submissions
            .Find(x => x.WorkspaceId == request.WorkspaceId && x.ContentType == "literary")
            .FirstOrDefaultAsync();
        if (existingWs != null)
            return Ok(ApiResponse<object>.Ok(new { submission = existingWs, created = false }));

        // 获取 workspace 封面图
        var coverUrl = "";
        var coverWidth = 0;
        var coverHeight = 0;
        if (workspace.CoverAssetIds.Count > 0)
        {
            var coverAsset = await _db.ImageAssets
                .Find(x => x.Id == workspace.CoverAssetIds[0])
                .FirstOrDefaultAsync();
            if (coverAsset != null)
            {
                coverUrl = coverAsset.Url;
                coverWidth = coverAsset.Width;
                coverHeight = coverAsset.Height;
            }
        }

        var wsUser = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var wsDisplayName = ResolveDisplayName(wsUser, username, userId);

        var wsSubmission = new Submission
        {
            Title = request.Title ?? workspace.Title,
            ContentType = "literary",
            CoverUrl = coverUrl,
            CoverWidth = coverWidth,
            CoverHeight = coverHeight,
            WorkspaceId = workspace.Id,
            OwnerUserId = userId,
            OwnerUserName = wsDisplayName,
            OwnerAvatarFileName = wsUser?.AvatarFileName,
            IsPublic = request.IsPublic ?? true,
        };

        await _db.Submissions.InsertOneAsync(wsSubmission);
        return Ok(ApiResponse<object>.Ok(new { submission = wsSubmission, created = true }));
    }

    /// <summary>
    /// 切换投稿公开状态
    /// </summary>
    [HttpPatch("{id}/visibility")]
    public async Task<IActionResult> ToggleVisibility(string id, [FromBody] ToggleVisibilityRequest request)
    {
        var userId = GetUserId();
        var submission = await _db.Submissions.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "投稿不存在"));
        if (submission.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只能修改自己的投稿"));

        await _db.Submissions.UpdateOneAsync(
            x => x.Id == id,
            Builders<Submission>.Update
                .Set(x => x.IsPublic, request.IsPublic)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new { id, isPublic = request.IsPublic }));
    }

    /// <summary>
    /// 删除投稿
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> DeleteSubmission(string id)
    {
        var userId = GetUserId();
        var submission = await _db.Submissions.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "投稿不存在"));
        if (submission.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只能删除自己的投稿"));

        await _db.Submissions.DeleteOneAsync(x => x.Id == id);
        await _db.SubmissionLikes.DeleteManyAsync(x => x.SubmissionId == id);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 点赞投稿（幂等）
    /// </summary>
    [HttpPost("{id}/likes")]
    public async Task<IActionResult> LikeSubmission(string id)
    {
        var userId = GetUserId();
        var username = GetUsername();
        var submission = await _db.Submissions.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "投稿不存在"));

        var currentUser = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var displayName = ResolveDisplayName(currentUser, username, userId);

        var like = new SubmissionLike
        {
            SubmissionId = id,
            UserId = userId,
            UserName = displayName,
            AvatarFileName = currentUser?.AvatarFileName,
        };

        try
        {
            await _db.SubmissionLikes.InsertOneAsync(like);
            // 更新冗余计数
            await _db.Submissions.UpdateOneAsync(
                x => x.Id == id,
                Builders<Submission>.Update.Inc(x => x.LikeCount, 1));
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 幂等：重复点赞不报错
        }

        var likeCount = await _db.SubmissionLikes.CountDocumentsAsync(x => x.SubmissionId == id);
        return Ok(ApiResponse<object>.Ok(new { likedByMe = true, count = likeCount }));
    }

    /// <summary>
    /// 取消点赞投稿（幂等）
    /// </summary>
    [HttpDelete("{id}/likes")]
    public async Task<IActionResult> UnlikeSubmission(string id)
    {
        var userId = GetUserId();
        var submission = await _db.Submissions.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "投稿不存在"));

        var result = await _db.SubmissionLikes.DeleteOneAsync(x => x.SubmissionId == id && x.UserId == userId);
        if (result.DeletedCount > 0)
        {
            await _db.Submissions.UpdateOneAsync(
                x => x.Id == id,
                Builders<Submission>.Update.Inc(x => x.LikeCount, -1));
        }

        var likeCount = await _db.SubmissionLikes.CountDocumentsAsync(x => x.SubmissionId == id);
        return Ok(ApiResponse<object>.Ok(new { likedByMe = false, count = likeCount }));
    }

    /// <summary>
    /// 批量自动投稿（用于生图完成后自动投稿）
    /// </summary>
    [HttpPost("auto-submit")]
    public async Task<IActionResult> AutoSubmit([FromBody] AutoSubmitRequest request)
    {
        var userId = GetUserId();
        var username = GetUsername();

        if (request.ImageAssetIds == null || request.ImageAssetIds.Count == 0)
            return BadRequest(ApiResponse<object>.Fail("EMPTY", "imageAssetIds 不能为空"));

        // 批量上限：防止单次提交过多 ID 导致大查询
        if (request.ImageAssetIds.Count > 50)
            request.ImageAssetIds = request.ImageAssetIds.Take(50).ToList();

        var assets = await _db.ImageAssets
            .Find(x => request.ImageAssetIds.Contains(x.Id) && x.OwnerUserId == userId)
            .ToListAsync();

        if (assets.Count == 0)
            return Ok(ApiResponse<object>.Ok(new { submitted = 0 }));

        var currentUser = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var displayName = ResolveDisplayName(currentUser, username, userId);

        // 过滤已投稿的
        var existingAssetIds = (await _db.Submissions
            .Find(x => request.ImageAssetIds.Contains(x.ImageAssetId!))
            .Project(x => x.ImageAssetId)
            .ToListAsync())
            .ToHashSet();

        var newSubmissions = new List<Submission>();
        foreach (var asset in assets)
        {
            if (existingAssetIds.Contains(asset.Id)) continue;

            newSubmissions.Add(new Submission
            {
                Title = asset.Prompt?.Substring(0, Math.Min(asset.Prompt.Length, 50)) ?? "未命名作品",
                ContentType = "visual",
                CoverUrl = asset.Url,
                CoverWidth = asset.Width,
                CoverHeight = asset.Height,
                WorkspaceId = asset.WorkspaceId,
                ImageAssetId = asset.Id,
                Prompt = asset.Prompt,
                OwnerUserId = userId,
                OwnerUserName = displayName,
                OwnerAvatarFileName = currentUser?.AvatarFileName,
                IsPublic = true,
            });
        }

        if (newSubmissions.Count > 0)
            await _db.Submissions.InsertManyAsync(newSubmissions);

        return Ok(ApiResponse<object>.Ok(new { submitted = newSubmissions.Count }));
    }

    /// <summary>
    /// 查询指定 ImageAsset 是否已投稿
    /// </summary>
    [HttpGet("check")]
    public async Task<IActionResult> CheckSubmission([FromQuery] string? imageAssetId, [FromQuery] string? workspaceId)
    {
        var userId = GetUserId();

        if (!string.IsNullOrWhiteSpace(imageAssetId))
        {
            var submission = await _db.Submissions
                .Find(x => x.ImageAssetId == imageAssetId && x.OwnerUserId == userId)
                .FirstOrDefaultAsync();
            return Ok(ApiResponse<object>.Ok(new { submitted = submission != null, submissionId = submission?.Id }));
        }

        if (!string.IsNullOrWhiteSpace(workspaceId))
        {
            var submission = await _db.Submissions
                .Find(x => x.WorkspaceId == workspaceId && x.ContentType == "literary" && x.OwnerUserId == userId)
                .FirstOrDefaultAsync();
            return Ok(ApiResponse<object>.Ok(new { submitted = submission != null, submissionId = submission?.Id }));
        }

        return BadRequest(ApiResponse<object>.Fail("MISSING_PARAM", "需要提供 imageAssetId 或 workspaceId"));
    }

    /// <summary>
    /// 迁移：为指定用户名的已有图片批量创建投稿（一次性操作）
    /// </summary>
    [HttpPost("migrate")]
    public async Task<IActionResult> MigrateUserSubmissions([FromQuery] string username = "admin")
    {
        // 查找用户
        var user = await _db.Users.Find(u => u.Username == username).FirstOrDefaultAsync();
        if (user == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", $"用户 {username} 不存在"));

        var userId = user.UserId;
        var displayName = ResolveDisplayName(user, null, userId);

        // 获取该用户的所有图片
        var assets = await _db.ImageAssets
            .Find(x => x.OwnerUserId == userId)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync();

        // 获取已有投稿的 ImageAssetId 集合
        var existingAssetIds = (await _db.Submissions
            .Find(x => x.OwnerUserId == userId && x.ContentType == "visual")
            .Project(x => x.ImageAssetId)
            .ToListAsync())
            .Where(x => x != null)
            .ToHashSet();

        var newSubmissions = new List<Submission>();
        foreach (var asset in assets)
        {
            if (existingAssetIds.Contains(asset.Id)) continue;
            if (string.IsNullOrWhiteSpace(asset.Url)) continue;

            newSubmissions.Add(new Submission
            {
                Title = asset.Prompt?.Substring(0, Math.Min(asset.Prompt.Length, 50)) ?? "未命名作品",
                ContentType = "visual",
                CoverUrl = asset.Url,
                CoverWidth = asset.Width,
                CoverHeight = asset.Height,
                WorkspaceId = asset.WorkspaceId,
                ImageAssetId = asset.Id,
                Prompt = asset.Prompt,
                OwnerUserId = userId,
                OwnerUserName = displayName,
                OwnerAvatarFileName = user.AvatarFileName,
                IsPublic = true,
                CreatedAt = asset.CreatedAt, // 保留原始创建时间
            });
        }

        if (newSubmissions.Count > 0)
            await _db.Submissions.InsertManyAsync(newSubmissions);

        return Ok(ApiResponse<object>.Ok(new
        {
            username,
            userId,
            totalAssets = assets.Count,
            alreadySubmitted = existingAssetIds.Count,
            newlySubmitted = newSubmissions.Count,
        }));
    }
}

public class CreateSubmissionRequest
{
    public string ContentType { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? ImageAssetId { get; set; }
    public string? WorkspaceId { get; set; }
    public bool? IsPublic { get; set; }
}

public class ToggleVisibilityRequest
{
    public bool IsPublic { get; set; }
}

public class AutoSubmitRequest
{
    public List<string> ImageAssetIds { get; set; } = new();
}
