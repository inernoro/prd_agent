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

    /// <summary>
    /// 为视觉创作投稿构建生成快照（完整输入配方）
    /// </summary>
    private async Task<GenerationSnapshot?> BuildVisualSnapshotAsync(string? workspaceId, string? imageAssetId, string ownerUserId)
    {
        if (string.IsNullOrWhiteSpace(workspaceId)) return null;

        // 1. 查找最近完成的 ImageGenRun
        var run = await _db.ImageGenRuns
            .Find(x => x.WorkspaceId == workspaceId && x.Status == ImageGenRunStatus.Completed)
            .SortByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync();
        if (run == null) return null;

        // 2. 查找 Workspace（系统提示词 + 风格提示词）
        var workspace = await _db.ImageMasterWorkspaces
            .Find(x => x.Id == workspaceId)
            .FirstOrDefaultAsync();

        // 3. 解析模型显示名
        string? modelName = run.ModelId;
        if (!string.IsNullOrWhiteSpace(run.ConfigModelId))
        {
            var model = await _db.LLMModels
                .Find(x => x.Id == run.ConfigModelId)
                .FirstOrDefaultAsync();
            modelName = model?.Name ?? model?.ModelName ?? run.ModelId;
        }

        // 4. 解析系统提示词
        string? spId = null, spTitle = null, spContent = null;
        if (workspace?.SelectedPromptId != null)
        {
            var sp = await _db.LiteraryPrompts
                .Find(x => x.Id == workspace.SelectedPromptId)
                .FirstOrDefaultAsync();
            if (sp != null)
            {
                spId = sp.Id;
                spTitle = sp.Title;
                spContent = sp.Content;
            }
        }

        // 5. 解析参考图
        var hasRefImage = !string.IsNullOrWhiteSpace(run.InitImageAssetSha256) || (run.ImageRefs?.Count > 0);
        var refCount = (run.ImageRefs?.Count ?? 0) + (!string.IsNullOrWhiteSpace(run.InitImageAssetSha256) ? 1 : 0);

        // 单图初始化：通过 SHA256 查找 URL
        string? initImageUrl = null;
        if (!string.IsNullOrWhiteSpace(run.InitImageAssetSha256))
        {
            var initAsset = await _db.ImageAssets
                .Find(x => x.Sha256 == run.InitImageAssetSha256)
                .SortByDescending(x => x.CreatedAt)
                .FirstOrDefaultAsync();
            initImageUrl = initAsset?.OriginalUrl ?? initAsset?.Url;
        }

        // 多图引用
        List<ImageRefSnapshot>? imageRefSnapshots = null;
        if (run.ImageRefs?.Count > 0)
        {
            imageRefSnapshots = run.ImageRefs.Select(r => new ImageRefSnapshot
            {
                RefId = r.RefId,
                Url = r.Url,
                Label = r.Label,
                Role = r.Role,
            }).ToList();
        }

        // 6. 解析水印（通过 appKey + userId 查找当时的配置）
        WatermarkConfig? wmConfig = null;
        var appKey = run.AppKey;
        if (!string.IsNullOrWhiteSpace(appKey))
        {
            wmConfig = await _db.WatermarkConfigs
                .Find(x => x.UserId == ownerUserId && x.AppKeys.Contains(appKey))
                .FirstOrDefaultAsync();
        }

        // 7. 解析水印配置创建者信息
        string? wmOwnerName = null;
        string? wmOwnerAvatar = null;
        if (wmConfig != null)
        {
            var wmOwner = await _db.Users
                .Find(u => u.UserId == wmConfig.UserId)
                .FirstOrDefaultAsync();
            wmOwnerName = wmOwner?.DisplayName ?? wmOwner?.Username;
            wmOwnerAvatar = wmOwner?.AvatarFileName;
        }

        return new GenerationSnapshot
        {
            ConfigModelId = run.ConfigModelId,
            ModelName = modelName,
            Size = run.Size,
            PromptText = run.Items?.FirstOrDefault()?.Prompt,
            StylePrompt = workspace?.StylePrompt,
            SystemPromptId = spId,
            SystemPromptTitle = spTitle,
            SystemPromptContent = spContent,
            HasReferenceImage = hasRefImage,
            ReferenceImageCount = refCount,
            InitImageUrl = initImageUrl,
            ImageRefs = imageRefSnapshots,
            HasInpainting = !string.IsNullOrWhiteSpace(run.MaskBase64),
            WatermarkConfigId = wmConfig?.Id,
            WatermarkName = wmConfig?.Name,
            WatermarkText = wmConfig?.Text,
            WatermarkFontKey = wmConfig?.FontKey,
            WatermarkFontSizePx = wmConfig?.FontSizePx,
            WatermarkOpacity = wmConfig?.Opacity,
            WatermarkAnchor = wmConfig?.Anchor,
            WatermarkOffsetX = wmConfig?.OffsetX,
            WatermarkOffsetY = wmConfig?.OffsetY,
            WatermarkPositionMode = wmConfig?.PositionMode,
            WatermarkIconEnabled = wmConfig?.IconEnabled,
            WatermarkBorderEnabled = wmConfig?.BorderEnabled,
            WatermarkBackgroundEnabled = wmConfig?.BackgroundEnabled,
            WatermarkRoundedBackgroundEnabled = wmConfig?.RoundedBackgroundEnabled,
            WatermarkPreviewUrl = wmConfig?.PreviewUrl,
            WatermarkForkCount = wmConfig?.ForkCount ?? 0,
            WatermarkOwnerUserName = wmOwnerName,
            WatermarkOwnerAvatarFileName = wmOwnerAvatar,
            ImageGenRunId = run.Id,
            AppKey = appKey,
            SnapshotAt = DateTime.UtcNow,
        };
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
        var sort = Builders<Submission>.Sort
            .Descending(x => x.LikeCount)
            .Descending(x => x.CreatedAt);
        var items = await _db.Submissions
            .Find(filter)
            .Sort(sort)
            .Skip(skip)
            .Limit(limit)
            .ToListAsync();

        // 查询当前用户是否已点赞
        var submissionIds = items.Select(x => x.Id).ToList();
        var myLikes = await _db.SubmissionLikes
            .Find(x => x.UserId == userId && submissionIds.Contains(x.SubmissionId))
            .ToListAsync();
        var likedSet = new HashSet<string>(myLikes.Select(x => x.SubmissionId));

        // 文学创作：动态获取 workspace 最新封面（新生成的图片自动出现）
        var literaryWorkspaceIds = items
            .Where(x => x.ContentType == "literary" && !string.IsNullOrWhiteSpace(x.WorkspaceId))
            .Select(x => x.WorkspaceId!)
            .Distinct()
            .ToList();
        var dynamicCovers = new Dictionary<string, (string url, int w, int h)>();
        if (literaryWorkspaceIds.Count > 0)
        {
            // 每个 workspace 取最新一张图片作为封面
            var coverAssets = await _db.ImageAssets
                .Find(x => literaryWorkspaceIds.Contains(x.WorkspaceId!))
                .SortByDescending(x => x.CreatedAt)
                .ToListAsync();
            foreach (var wsId in literaryWorkspaceIds)
            {
                var latest = coverAssets.FirstOrDefault(a => a.WorkspaceId == wsId);
                if (latest != null && !string.IsNullOrWhiteSpace(latest.Url))
                    dynamicCovers[wsId] = (latest.Url, latest.Width, latest.Height);
            }
        }

        var result = items.Select(x =>
        {
            var coverUrl = x.CoverUrl;
            var coverWidth = x.CoverWidth;
            var coverHeight = x.CoverHeight;
            // 文学创作：优先使用 workspace 最新资产作为封面
            if (x.ContentType == "literary" && x.WorkspaceId != null && dynamicCovers.TryGetValue(x.WorkspaceId, out var dc))
            {
                coverUrl = dc.url;
                coverWidth = dc.w;
                coverHeight = dc.h;
            }
            return new
            {
                x.Id,
                x.Title,
                x.ContentType,
                coverUrl,
                coverWidth,
                coverHeight,
                x.Prompt,
                x.OwnerUserId,
                x.OwnerUserName,
                x.OwnerAvatarFileName,
                x.LikeCount,
                likedByMe = likedSet.Contains(x.Id),
                x.CreatedAt,
            };
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
        // 生成参数信息（优先用快照，兜底动态查询）
        object? generationInfo = null;

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

        // 生成参数（visual + literary 共用，只要有 workspaceId）
        if (!string.IsNullOrWhiteSpace(submission.WorkspaceId))
        {
            // 优先使用持久化快照
            if (submission.GenerationSnapshot != null)
            {
                var snap = submission.GenerationSnapshot;
                generationInfo = new
                {
                    modelName = snap.ModelName,
                    size = snap.Size,
                    promptText = snap.PromptText,
                    stylePrompt = snap.StylePrompt,
                    // 提示词 Tab
                    systemPromptId = snap.SystemPromptId,
                    systemPromptName = snap.SystemPromptTitle,
                    systemPromptContent = snap.SystemPromptContent,
                    // 参考图 Tab
                    hasReferenceImage = snap.HasReferenceImage,
                    referenceImageCount = snap.ReferenceImageCount,
                    initImageUrl = snap.InitImageUrl,
                    imageRefs = snap.ImageRefs,
                    hasInpainting = snap.HasInpainting,
                    referenceImageConfigId = snap.ReferenceImageConfigId,
                    referenceImageConfigName = snap.ReferenceImageConfigName,
                    // 水印 Tab
                    watermarkConfigId = snap.WatermarkConfigId,
                    watermarkName = snap.WatermarkName,
                    watermarkText = snap.WatermarkText,
                    watermarkFontKey = snap.WatermarkFontKey,
                    watermarkFontSizePx = snap.WatermarkFontSizePx,
                    watermarkOpacity = snap.WatermarkOpacity,
                    watermarkAnchor = snap.WatermarkAnchor,
                    watermarkOffsetX = snap.WatermarkOffsetX,
                    watermarkOffsetY = snap.WatermarkOffsetY,
                    watermarkPositionMode = snap.WatermarkPositionMode,
                    watermarkIconEnabled = snap.WatermarkIconEnabled,
                    watermarkBorderEnabled = snap.WatermarkBorderEnabled,
                    watermarkBackgroundEnabled = snap.WatermarkBackgroundEnabled,
                    watermarkRoundedBackgroundEnabled = snap.WatermarkRoundedBackgroundEnabled,
                    watermarkPreviewUrl = snap.WatermarkPreviewUrl,
                    watermarkForkCount = snap.WatermarkForkCount,
                    watermarkOwnerUserName = snap.WatermarkOwnerUserName,
                    watermarkOwnerAvatarFileName = snap.WatermarkOwnerAvatarFileName,
                    // 溯源
                    appKey = snap.AppKey,
                    configModelId = snap.ConfigModelId,
                };
            }
            else
            {
                // 兜底：动态查询（旧数据未回填 GenerationSnapshot 时）
                var run = await _db.ImageGenRuns
                    .Find(x => x.WorkspaceId == submission.WorkspaceId && x.Status == ImageGenRunStatus.Completed)
                    .SortByDescending(x => x.CreatedAt)
                    .FirstOrDefaultAsync();
                if (run != null)
                {
                    string? modelDisplayName = null;
                    if (!string.IsNullOrWhiteSpace(run.ConfigModelId))
                    {
                        var model = await _db.LLMModels
                            .Find(x => x.Id == run.ConfigModelId)
                            .FirstOrDefaultAsync();
                        modelDisplayName = model?.Name ?? model?.ModelName ?? run.ModelId;
                    }
                    else
                    {
                        modelDisplayName = run.ModelId;
                    }

                    string? systemPromptName = null;
                    string? systemPromptContent = null;
                    var fbWorkspace = await _db.ImageMasterWorkspaces
                        .Find(x => x.Id == submission.WorkspaceId)
                        .FirstOrDefaultAsync();
                    if (fbWorkspace?.SelectedPromptId != null)
                    {
                        var sp = await _db.LiteraryPrompts
                            .Find(x => x.Id == fbWorkspace.SelectedPromptId)
                            .FirstOrDefaultAsync();
                        systemPromptName = sp?.Title;
                        systemPromptContent = sp?.Content;
                    }

                    // 参考图
                    var hasRefImage = !string.IsNullOrWhiteSpace(run.InitImageAssetSha256) || (run.ImageRefs?.Count > 0);
                    var refCount = (run.ImageRefs?.Count ?? 0) + (!string.IsNullOrWhiteSpace(run.InitImageAssetSha256) ? 1 : 0);
                    string? initImageUrl = null;
                    if (!string.IsNullOrWhiteSpace(run.InitImageAssetSha256))
                    {
                        var initAsset = await _db.ImageAssets
                            .Find(x => x.Sha256 == run.InitImageAssetSha256)
                            .SortByDescending(x => x.CreatedAt)
                            .FirstOrDefaultAsync();
                        initImageUrl = initAsset?.OriginalUrl ?? initAsset?.Url;
                    }
                    List<ImageRefSnapshot>? imageRefSnapshots = null;
                    if (run.ImageRefs?.Count > 0)
                    {
                        imageRefSnapshots = run.ImageRefs.Select(r => new ImageRefSnapshot
                        {
                            RefId = r.RefId, Url = r.Url, Label = r.Label, Role = r.Role,
                        }).ToList();
                    }

                    // 水印
                    WatermarkConfig? fbWmConfig = null;
                    var appKey = run.AppKey;
                    if (!string.IsNullOrWhiteSpace(appKey))
                    {
                        fbWmConfig = await _db.WatermarkConfigs
                            .Find(x => x.UserId == submission.OwnerUserId && x.AppKeys.Contains(appKey))
                            .FirstOrDefaultAsync();
                    }
                    // 水印配置创建者信息
                    string? fbWmOwnerName = null;
                    string? fbWmOwnerAvatar = null;
                    if (fbWmConfig != null)
                    {
                        var fbWmOwner = await _db.Users
                            .Find(u => u.UserId == fbWmConfig.UserId)
                            .FirstOrDefaultAsync();
                        fbWmOwnerName = fbWmOwner?.DisplayName ?? fbWmOwner?.Username;
                        fbWmOwnerAvatar = fbWmOwner?.AvatarFileName;
                    }

                    generationInfo = new
                    {
                        modelName = modelDisplayName,
                        size = run.Size,
                        promptText = run.Items?.FirstOrDefault()?.Prompt,
                        stylePrompt = fbWorkspace?.StylePrompt,
                        systemPromptName,
                        systemPromptContent,
                        hasReferenceImage = hasRefImage,
                        referenceImageCount = refCount,
                        initImageUrl,
                        imageRefs = imageRefSnapshots,
                        hasInpainting = !string.IsNullOrWhiteSpace(run.MaskBase64),
                        watermarkConfigId = fbWmConfig?.Id,
                        watermarkName = fbWmConfig?.Name,
                        watermarkText = fbWmConfig?.Text,
                        watermarkFontKey = fbWmConfig?.FontKey,
                        watermarkFontSizePx = fbWmConfig?.FontSizePx,
                        watermarkOpacity = fbWmConfig?.Opacity,
                        watermarkAnchor = fbWmConfig?.Anchor,
                        watermarkOffsetX = fbWmConfig?.OffsetX,
                        watermarkOffsetY = fbWmConfig?.OffsetY,
                        watermarkPositionMode = fbWmConfig?.PositionMode,
                        watermarkIconEnabled = fbWmConfig?.IconEnabled,
                        watermarkBorderEnabled = fbWmConfig?.BorderEnabled,
                        watermarkBackgroundEnabled = fbWmConfig?.BackgroundEnabled,
                        watermarkRoundedBackgroundEnabled = fbWmConfig?.RoundedBackgroundEnabled,
                        watermarkPreviewUrl = fbWmConfig?.PreviewUrl,
                        watermarkForkCount = fbWmConfig?.ForkCount ?? 0,
                        watermarkOwnerUserName = fbWmOwnerName,
                        watermarkOwnerAvatarFileName = fbWmOwnerAvatar,
                        appKey,
                    };
                }
            }
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
            generationInfo,
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

            // 构建生成快照（完整输入配方）
            var snapshot = await BuildVisualSnapshotAsync(asset.WorkspaceId, asset.Id, userId);

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
                GenerationSnapshot = snapshot,
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

        // 构建生成快照（literary 也有图片生成参数）
        var literarySnapshot = await BuildVisualSnapshotAsync(workspace.Id, null, userId);

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
            GenerationSnapshot = literarySnapshot,
        };

        await _db.Submissions.InsertOneAsync(wsSubmission);

        // 标记 workspace 为公开（文学投稿 = 公开 workspace）
        if (!workspace.IsPublic)
        {
            await _db.ImageMasterWorkspaces.UpdateOneAsync(
                x => x.Id == workspace.Id,
                Builders<ImageMasterWorkspace>.Update
                    .Set(x => x.IsPublic, true)
                    .Set(x => x.PublishedAt, DateTime.UtcNow));
        }

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

        // 文学创作：同步 workspace 公开状态
        if (submission.ContentType == "literary" && !string.IsNullOrWhiteSpace(submission.WorkspaceId))
        {
            await _db.ImageMasterWorkspaces.UpdateOneAsync(
                x => x.Id == submission.WorkspaceId,
                Builders<ImageMasterWorkspace>.Update.Set(x => x.IsPublic, request.IsPublic));
        }

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

        // 文学创作：同步取消 workspace 公开状态
        if (submission.ContentType == "literary" && !string.IsNullOrWhiteSpace(submission.WorkspaceId))
        {
            await _db.ImageMasterWorkspaces.UpdateOneAsync(
                x => x.Id == submission.WorkspaceId,
                Builders<ImageMasterWorkspace>.Update.Set(x => x.IsPublic, false));
        }

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
        // 按 WorkspaceId 分组构建快照，避免重复查询
        var snapshotCache = new Dictionary<string, GenerationSnapshot?>();
        foreach (var asset in assets)
        {
            if (existingAssetIds.Contains(asset.Id)) continue;

            GenerationSnapshot? snapshot = null;
            if (!string.IsNullOrWhiteSpace(asset.WorkspaceId))
            {
                if (!snapshotCache.TryGetValue(asset.WorkspaceId, out snapshot))
                {
                    snapshot = await BuildVisualSnapshotAsync(asset.WorkspaceId, asset.Id, userId);
                    snapshotCache[asset.WorkspaceId] = snapshot;
                }
            }

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
                GenerationSnapshot = snapshot,
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
            // 同时检查 workspace IsPublic 和 Submission 记录（兼容旧数据）
            var submission = await _db.Submissions
                .Find(x => x.WorkspaceId == workspaceId && x.ContentType == "literary" && x.OwnerUserId == userId)
                .FirstOrDefaultAsync();
            if (submission != null)
            {
                // 旧数据兼容：有 Submission 但 workspace 未标记 IsPublic，补标记
                var ws = await _db.ImageMasterWorkspaces
                    .Find(x => x.Id == workspaceId)
                    .FirstOrDefaultAsync();
                if (ws != null && !ws.IsPublic)
                {
                    await _db.ImageMasterWorkspaces.UpdateOneAsync(
                        x => x.Id == workspaceId,
                        Builders<ImageMasterWorkspace>.Update
                            .Set(x => x.IsPublic, true)
                            .Set(x => x.PublishedAt, submission.CreatedAt));
                }
                return Ok(ApiResponse<object>.Ok(new { submitted = submission.IsPublic, submissionId = submission.Id }));
            }
            // 无 Submission 记录，检查 workspace IsPublic（新流程创建的可能先标记了 workspace）
            var wsCheck = await _db.ImageMasterWorkspaces
                .Find(x => x.Id == workspaceId && x.OwnerUserId == userId && x.IsPublic == true)
                .AnyAsync();
            return Ok(ApiResponse<object>.Ok(new { submitted = wsCheck }));
        }

        return BadRequest(ApiResponse<object>.Fail("MISSING_PARAM", "需要提供 imageAssetId 或 workspaceId"));
    }

    /// <summary>
    /// 迁移：为指定用户名的已有图片批量创建投稿（一次性操作）
    /// </summary>
    [HttpPost("migrate")]
    [AllowAnonymous]
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
        var migrateSnapshotCache = new Dictionary<string, GenerationSnapshot?>();
        foreach (var asset in assets)
        {
            if (existingAssetIds.Contains(asset.Id)) continue;
            if (string.IsNullOrWhiteSpace(asset.Url)) continue;

            GenerationSnapshot? snapshot = null;
            if (!string.IsNullOrWhiteSpace(asset.WorkspaceId))
            {
                if (!migrateSnapshotCache.TryGetValue(asset.WorkspaceId, out snapshot))
                {
                    snapshot = await BuildVisualSnapshotAsync(asset.WorkspaceId, asset.Id, userId);
                    migrateSnapshotCache[asset.WorkspaceId] = snapshot;
                }
            }

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
                CreatedAt = asset.CreatedAt,
                GenerationSnapshot = snapshot,
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

    /// <summary>
    /// 迁移：为指定用户名的文学创作 workspace 批量创建投稿（一次性操作）
    /// </summary>
    [HttpPost("migrate-literary")]
    [AllowAnonymous]
    public async Task<IActionResult> MigrateLiterarySubmissions([FromQuery] string username = "admin")
    {
        var user = await _db.Users.Find(u => u.Username == username).FirstOrDefaultAsync();
        if (user == null)
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", $"用户 {username} 不存在"));

        var userId = user.UserId;
        var displayName = ResolveDisplayName(user, null, userId);

        // 获取用户的文学创作 workspace（article-illustration 场景）
        var workspaces = await _db.ImageMasterWorkspaces
            .Find(x => x.OwnerUserId == userId && x.ScenarioType == "article-illustration")
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync();

        // 过滤已投稿的
        var workspaceIds = workspaces.Select(x => x.Id).ToList();
        var existingWsIds = (await _db.Submissions
            .Find(x => x.OwnerUserId == userId && x.ContentType == "literary" && workspaceIds.Contains(x.WorkspaceId!))
            .Project(x => x.WorkspaceId)
            .ToListAsync())
            .Where(x => x != null)
            .ToHashSet();

        var newSubmissions = new List<Submission>();
        foreach (var ws in workspaces)
        {
            if (existingWsIds.Contains(ws.Id)) continue;

            // 获取封面图
            var coverUrl = "";
            var coverWidth = 0;
            var coverHeight = 0;

            // 尝试获取 workspace 的配图
            var firstAsset = await _db.ImageAssets
                .Find(x => x.WorkspaceId == ws.Id)
                .SortBy(x => x.ArticleInsertionIndex)
                .ThenBy(x => x.CreatedAt)
                .FirstOrDefaultAsync();
            if (firstAsset != null)
            {
                coverUrl = firstAsset.Url;
                coverWidth = firstAsset.Width;
                coverHeight = firstAsset.Height;
            }
            else if (ws.CoverAssetIds.Count > 0)
            {
                var coverAsset = await _db.ImageAssets
                    .Find(x => x.Id == ws.CoverAssetIds[0])
                    .FirstOrDefaultAsync();
                if (coverAsset != null)
                {
                    coverUrl = coverAsset.Url;
                    coverWidth = coverAsset.Width;
                    coverHeight = coverAsset.Height;
                }
            }

            // 跳过没有封面的
            if (string.IsNullOrWhiteSpace(coverUrl)) continue;

            newSubmissions.Add(new Submission
            {
                Title = ws.Title ?? "未命名作品",
                ContentType = "literary",
                CoverUrl = coverUrl,
                CoverWidth = coverWidth,
                CoverHeight = coverHeight,
                WorkspaceId = ws.Id,
                Prompt = ws.ArticleContent?.Substring(0, Math.Min(ws.ArticleContent.Length, 200)),
                OwnerUserId = userId,
                OwnerUserName = displayName,
                OwnerAvatarFileName = user.AvatarFileName,
                IsPublic = true,
                CreatedAt = ws.CreatedAt,
            });
        }

        if (newSubmissions.Count > 0)
            await _db.Submissions.InsertManyAsync(newSubmissions);

        return Ok(ApiResponse<object>.Ok(new
        {
            username,
            userId,
            totalWorkspaces = workspaces.Count,
            alreadySubmitted = existingWsIds.Count,
            newlySubmitted = newSubmissions.Count,
        }));
    }
    /// <summary>
    /// 回填：为已有投稿补充生成快照（一次性操作）
    /// 处理 visual + literary 类型中尚无 GenerationSnapshot 的投稿
    /// </summary>
    [HttpPost("backfill-snapshots")]
    [AllowAnonymous]
    public async Task<IActionResult> BackfillSnapshots(
        [FromQuery] string? username = null,
        [FromQuery] int batchSize = 100)
    {
        batchSize = Math.Clamp(batchSize, 1, 500);

        // 构建过滤器：visual/literary 类型 + 无快照
        var filterBuilder = Builders<Submission>.Filter;
        var filter = (filterBuilder.Eq(x => x.ContentType, "visual") | filterBuilder.Eq(x => x.ContentType, "literary"))
            & filterBuilder.Eq(x => x.GenerationSnapshot, null);

        if (!string.IsNullOrWhiteSpace(username))
        {
            var user = await _db.Users.Find(u => u.Username == username).FirstOrDefaultAsync();
            if (user == null)
                return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", $"用户 {username} 不存在"));
            filter &= filterBuilder.Eq(x => x.OwnerUserId, user.UserId);
        }

        var submissions = await _db.Submissions
            .Find(filter)
            .Limit(batchSize)
            .ToListAsync();

        var updated = 0;
        var snapshotCache = new Dictionary<string, GenerationSnapshot?>();

        foreach (var sub in submissions)
        {
            if (string.IsNullOrWhiteSpace(sub.WorkspaceId)) continue;

            if (!snapshotCache.TryGetValue(sub.WorkspaceId, out var snapshot))
            {
                snapshot = await BuildVisualSnapshotAsync(sub.WorkspaceId, sub.ImageAssetId, sub.OwnerUserId);
                snapshotCache[sub.WorkspaceId] = snapshot;
            }

            if (snapshot == null) continue;

            await _db.Submissions.UpdateOneAsync(
                x => x.Id == sub.Id,
                Builders<Submission>.Update.Set(x => x.GenerationSnapshot, snapshot));
            updated++;
        }

        // 统计剩余未回填的数量
        // filter 已排除刚更新的（它们现在有快照了），所以 count 直接就是剩余量
        var remaining = await _db.Submissions.CountDocumentsAsync(filter);

        return Ok(ApiResponse<object>.Ok(new
        {
            processed = submissions.Count,
            updated,
            remaining,
        }));
    }

    /// <summary>
    /// 从投稿快照 Fork 水印配置（不要求原配置公开）
    /// </summary>
    [HttpPost("{id}/fork-watermark")]
    public async Task<IActionResult> ForkWatermarkFromSnapshot(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var submission = await _db.Submissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "投稿不存在"));
        if (!submission.IsPublic && submission.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "该投稿未公开"));

        // 获取水印快照数据（优先快照，兜底动态查询）
        string? wmName = null, wmText = null, wmFontKey = null, wmAnchor = null, wmPositionMode = null;
        double? wmFontSizePx = null, wmOpacity = null, wmOffsetX = null, wmOffsetY = null;
        bool? wmIconEnabled = null, wmBorderEnabled = null, wmBackgroundEnabled = null, wmRoundedBgEnabled = null;
        string? sourceConfigId = null;

        if (submission.GenerationSnapshot != null)
        {
            var snap = submission.GenerationSnapshot;
            sourceConfigId = snap.WatermarkConfigId;
            wmName = snap.WatermarkName;
            wmText = snap.WatermarkText;
            wmFontKey = snap.WatermarkFontKey;
            wmFontSizePx = snap.WatermarkFontSizePx;
            wmOpacity = snap.WatermarkOpacity;
            wmAnchor = snap.WatermarkAnchor;
            wmOffsetX = snap.WatermarkOffsetX;
            wmOffsetY = snap.WatermarkOffsetY;
            wmPositionMode = snap.WatermarkPositionMode;
            wmIconEnabled = snap.WatermarkIconEnabled;
            wmBorderEnabled = snap.WatermarkBorderEnabled;
            wmBackgroundEnabled = snap.WatermarkBackgroundEnabled;
            wmRoundedBgEnabled = snap.WatermarkRoundedBackgroundEnabled;
        }
        else if (!string.IsNullOrWhiteSpace(submission.WorkspaceId))
        {
            var run = await _db.ImageGenRuns
                .Find(x => x.WorkspaceId == submission.WorkspaceId && x.Status == ImageGenRunStatus.Completed)
                .SortByDescending(x => x.CreatedAt)
                .FirstOrDefaultAsync(ct);
            if (run != null && !string.IsNullOrWhiteSpace(run.AppKey))
            {
                var wmConfig = await _db.WatermarkConfigs
                    .Find(x => x.UserId == submission.OwnerUserId && x.AppKeys.Contains(run.AppKey))
                    .FirstOrDefaultAsync(ct);
                if (wmConfig != null)
                {
                    sourceConfigId = wmConfig.Id;
                    wmName = wmConfig.Name;
                    wmText = wmConfig.Text;
                    wmFontKey = wmConfig.FontKey;
                    wmFontSizePx = wmConfig.FontSizePx;
                    wmOpacity = wmConfig.Opacity;
                    wmAnchor = wmConfig.Anchor;
                    wmOffsetX = wmConfig.OffsetX;
                    wmOffsetY = wmConfig.OffsetY;
                    wmPositionMode = wmConfig.PositionMode;
                    wmIconEnabled = wmConfig.IconEnabled;
                    wmBorderEnabled = wmConfig.BorderEnabled;
                    wmBackgroundEnabled = wmConfig.BackgroundEnabled;
                    wmRoundedBgEnabled = wmConfig.RoundedBackgroundEnabled;
                }
            }
        }

        if (string.IsNullOrWhiteSpace(wmName))
            return BadRequest(ApiResponse<object>.Fail("NO_WATERMARK", "该投稿未使用水印"));

        // 获取原作者信息
        var sourceOwner = await _db.Users
            .Find(u => u.UserId == submission.OwnerUserId)
            .FirstOrDefaultAsync(ct);
        var sourceOwnerName = sourceOwner?.DisplayName ?? sourceOwner?.Username ?? "未知用户";
        var sourceOwnerAvatar = sourceOwner?.AvatarFileName;

        var forked = new WatermarkConfig
        {
            Id = Guid.NewGuid().ToString("N"),
            UserId = userId,
            Name = wmName,
            AppKeys = new List<string>(),
            Text = wmText ?? "",
            FontKey = wmFontKey ?? "default",
            FontSizePx = wmFontSizePx ?? 0,
            Opacity = wmOpacity ?? 1,
            Anchor = wmAnchor ?? "bottom-right",
            OffsetX = wmOffsetX ?? 24,
            OffsetY = wmOffsetY ?? 24,
            PositionMode = wmPositionMode ?? "pixel",
            IconEnabled = wmIconEnabled ?? false,
            BorderEnabled = wmBorderEnabled ?? false,
            BackgroundEnabled = wmBackgroundEnabled ?? false,
            RoundedBackgroundEnabled = wmRoundedBgEnabled ?? false,
            IsPublic = false,
            ForkCount = 0,
            ForkedFromId = sourceConfigId,
            ForkedFromUserId = submission.OwnerUserId,
            ForkedFromUserName = sourceOwnerName,
            ForkedFromUserAvatar = sourceOwnerAvatar,
            IsModifiedAfterFork = false,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };

        await _db.WatermarkConfigs.InsertOneAsync(forked, cancellationToken: ct);

        // 如果有原配置 ID，更新 ForkCount
        if (!string.IsNullOrWhiteSpace(sourceConfigId))
        {
            await _db.WatermarkConfigs.UpdateOneAsync(
                x => x.Id == sourceConfigId,
                Builders<WatermarkConfig>.Update.Inc(x => x.ForkCount, 1),
                cancellationToken: ct);
        }

        // 记录下载日志
        var currentUser = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        var forkLog = new MarketplaceForkLog
        {
            Id = Guid.NewGuid().ToString("N"),
            UserId = userId,
            UserName = currentUser?.DisplayName ?? currentUser?.Username,
            UserAvatarFileName = currentUser?.AvatarFileName,
            ConfigType = "watermark",
            SourceConfigId = sourceConfigId ?? id,
            SourceConfigName = wmName,
            ForkedConfigId = forked.Id,
            ForkedConfigName = wmName,
            SourceOwnerUserId = submission.OwnerUserId,
            SourceOwnerName = sourceOwnerName,
            CreatedAt = DateTime.UtcNow,
        };
        await _db.MarketplaceForkLogs.InsertOneAsync(forkLog, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { id = forked.Id, name = forked.Name }));
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
