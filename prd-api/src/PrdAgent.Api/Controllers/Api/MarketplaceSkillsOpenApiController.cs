using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Api.Controllers.Api.OfficialSkills;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Infrastructure.Services.MarketplaceSkills;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 海鲜市场技能开放接口 —— 专供外部 AI / Agent 调用。
///
/// 鉴权：`Authorization: Bearer sk-ak-xxxx`（AgentApiKey）。
/// 权限：读操作需 scope `marketplace.skills:read`，写操作需 `marketplace.skills:write`。
///
/// 与 <see cref="MarketplaceSkillsController"/> 的区别：
/// - 本 Controller 是 AI 友好的简化版，只走 AgentApiKey 鉴权
/// - 上传接口去掉了封面图 / 托管站点绑定等偏 UI 的参数，便于 curl / SDK 调用
/// </summary>
[ApiController]
[Route("api/open/marketplace/skills")]
[Authorize(AuthenticationSchemes = "ApiKey")]
public class MarketplaceSkillsOpenApiController : ControllerBase
{
    public const string ScopeRead = "marketplace.skills:read";
    public const string ScopeWrite = "marketplace.skills:write";

    private const long MaxZipBytes = 20L * 1024 * 1024;
    private const int DescriptionMaxChars = 200;
    private const int TitleMaxChars = 80;
    private const int MaxTagsPerItem = 10;
    private const int MaxTagLength = 20;

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly SkillZipMetadataExtractor _zipExtractor;
    private readonly ILogger<MarketplaceSkillsOpenApiController> _logger;

    public MarketplaceSkillsOpenApiController(
        MongoDbContext db,
        IAssetStorage assetStorage,
        SkillZipMetadataExtractor zipExtractor,
        ILogger<MarketplaceSkillsOpenApiController> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _zipExtractor = zipExtractor;
        _logger = logger;
    }

    // ======================================================================
    // 列表 / 查询
    // ======================================================================

    [HttpGet]
    [RequireScope(ScopeRead)]
    public async Task<IActionResult> List(
        [FromQuery] string? keyword,
        [FromQuery] string? sort,
        [FromQuery] string? tag,
        [FromQuery] int limit,
        CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var builder = Builders<MarketplaceSkill>.Filter;
        var filter = builder.Eq(x => x.IsPublic, true);

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var escaped = Regex.Escape(keyword.Trim());
            var regex = new BsonRegularExpression(escaped, "i");
            filter = builder.And(filter, builder.Or(
                builder.Regex(x => x.Title, regex),
                builder.Regex(x => x.Description, regex)));
        }
        if (!string.IsNullOrWhiteSpace(tag))
            filter = builder.And(filter, builder.AnyEq(x => x.Tags, tag.Trim()));

        var query = _db.MarketplaceSkills.Find(filter);
        query = sort switch
        {
            "new" => query.SortByDescending(x => x.CreatedAt),
            _ => query.SortByDescending(x => x.DownloadCount).ThenByDescending(x => x.CreatedAt)
        };

        var resolvedLimit = limit is > 0 and <= 200 ? limit : 50;
        var items = await query.Limit(resolvedLimit).ToListAsync(ct);
        var dtos = items.Select(s => ToDto(s, userId)).Cast<object>().ToList();

        // 虚拟注入官方 findmapskills 到首位 —— AI 搜 `findmapskills` / `海鲜市场` 就能直接发现
        if (OfficialMarketplaceSkillInjector.ShouldInject(keyword, tag))
        {
            var baseUrl = OfficialMarketplaceSkillInjector.ResolveBaseUrl(Request);
            dtos.Insert(0, OfficialMarketplaceSkillInjector.BuildFindMapSkillsDto(baseUrl, userId));
        }

        return Ok(ApiResponse<object>.Ok(new { items = dtos }));
    }

    [HttpGet("{id}")]
    [RequireScope(ScopeRead)]
    public async Task<IActionResult> GetById(string id, CancellationToken ct)
    {
        var userId = GetBoundUserId();

        // 官方虚拟条目：直接返回内存构造的 DTO，不查 DB
        if (OfficialMarketplaceSkillInjector.IsOfficialId(id))
        {
            var baseUrl = OfficialMarketplaceSkillInjector.ResolveBaseUrl(Request);
            return Ok(ApiResponse<object>.Ok(new { item = OfficialMarketplaceSkillInjector.BuildFindMapSkillsDto(baseUrl, userId) }));
        }

        var skill = await _db.MarketplaceSkills.Find(x => x.Id == id && x.IsPublic).FirstOrDefaultAsync(ct);
        if (skill == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "技能不存在或已下架"));
        return Ok(ApiResponse<object>.Ok(new { item = ToDto(skill, userId) }));
    }

    [HttpGet("tags")]
    [RequireScope(ScopeRead)]
    public async Task<IActionResult> Tags(CancellationToken ct)
    {
        var allTags = await _db.MarketplaceSkills
            .Find(x => x.IsPublic)
            .Project(x => x.Tags)
            .ToListAsync(ct);

        var distinct = allTags
            .SelectMany(x => x ?? new List<string>())
            .Where(t => !string.IsNullOrWhiteSpace(t))
            .Select(t => t.Trim())
            .GroupBy(t => t)
            .OrderByDescending(g => g.Count())
            .Take(50)
            .Select(g => new { tag = g.Key, count = g.Count() })
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { tags = distinct }));
    }

    // ======================================================================
    // 下载 / Fork（计数 +1 + 返回 zip 下载 URL）
    // ======================================================================

    [HttpPost("{id}/fork")]
    [RequireScope(ScopeRead)]
    public async Task<IActionResult> Fork(string id, CancellationToken ct)
    {
        var userId = GetBoundUserId();

        // 官方虚拟条目：返回官方下载 URL，不 +1 count、不查 DB
        if (OfficialMarketplaceSkillInjector.IsOfficialId(id))
        {
            var baseUrl = OfficialMarketplaceSkillInjector.ResolveBaseUrl(Request);
            return Ok(ApiResponse<object>.Ok(OfficialMarketplaceSkillInjector.BuildForkResponse(baseUrl, userId)));
        }

        var skill = await _db.MarketplaceSkills.Find(x => x.Id == id && x.IsPublic).FirstOrDefaultAsync(ct);
        if (skill == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "技能不存在或已下架"));

        await _db.MarketplaceSkills.UpdateOneAsync(
            x => x.Id == id,
            Builders<MarketplaceSkill>.Update
                .Inc(x => x.DownloadCount, 1)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        skill.DownloadCount += 1;
        skill.UpdatedAt = DateTime.UtcNow;
        return Ok(ApiResponse<object>.Ok(new
        {
            downloadUrl = skill.ZipUrl,
            fileName = skill.OriginalFileName,
            item = ToDto(skill, userId)
        }));
    }

    // ======================================================================
    // 上传（简化版，不含封面/预览 URL；需要这些的请走 UI 上传）
    // ======================================================================

    [HttpPost("upload")]
    [RequireScope(ScopeWrite)]
    [RequestSizeLimit(MaxZipBytes + 512 * 1024)]
    public async Task<IActionResult> Upload(
        [FromForm] IFormFile file,
        [FromForm] string? title,
        [FromForm] string? description,
        [FromForm] string? iconEmoji,
        [FromForm] string? tagsJson,
        CancellationToken ct)
    {
        var userId = GetBoundUserId();

        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FILE", "请上传 zip 技能包"));
        if (file.Length > MaxZipBytes)
            return BadRequest(ApiResponse<object>.Fail("FILE_TOO_LARGE", $"文件大小不能超过 {MaxZipBytes / 1024 / 1024}MB"));

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (ext != ".zip")
            return BadRequest(ApiResponse<object>.Fail("INVALID_FILE", "仅支持 .zip 格式的技能包"));

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct);
        var bytes = ms.ToArray();

        var meta = _zipExtractor.Extract(bytes);
        if (!string.IsNullOrEmpty(meta.Error))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FILE", $"压缩包解析失败: {meta.Error}"));

        var id = Guid.NewGuid().ToString("N");
        var safeName = SanitizeFileName(file.FileName);
        var key = $"marketplace-skills/{id}/{safeName}";
        try
        {
            await _assetStorage.UploadToKeyAsync(key, bytes, "application/zip", ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenApi] MarketplaceSkill 上传对象存储失败 userId={UserId} key={Key}", userId, key);
            return StatusCode(500, ApiResponse<object>.Fail("UPLOAD_FAILED", "上传到存储失败，请稍后重试"));
        }
        var zipUrl = _assetStorage.BuildUrlForKey(key);

        var finalTitle = TrimChars(
            string.IsNullOrWhiteSpace(title) ? Path.GetFileNameWithoutExtension(file.FileName) : title.Trim(),
            TitleMaxChars);
        if (string.IsNullOrWhiteSpace(finalTitle)) finalTitle = "未命名技能";

        var finalDescription = TrimChars(
            string.IsNullOrWhiteSpace(description) ? finalTitle : description.Trim(),
            DescriptionMaxChars);

        var tags = ParseTags(tagsJson);
        var finalIcon = string.IsNullOrWhiteSpace(iconEmoji) ? "🧩" : iconEmoji.Trim();
        if (finalIcon.Length > 4) finalIcon = finalIcon[..4];

        // 作者快照（用绑定用户）
        var author = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        var authorName = author?.DisplayName ?? author?.Username ?? "未知用户";
        var authorAvatar = author?.AvatarFileName;

        var skill = new MarketplaceSkill
        {
            Id = id,
            Title = finalTitle,
            Description = finalDescription,
            IconEmoji = finalIcon,
            Tags = tags,
            OwnerUserId = userId,
            AuthorName = authorName,
            AuthorAvatar = authorAvatar,
            ZipKey = key,
            ZipUrl = zipUrl,
            ZipSizeBytes = bytes.LongLength,
            OriginalFileName = file.FileName,
            HasSkillMd = meta.HasSkillMd,
            SkillMdPreview = meta.SkillMdPreview,
            ManifestVersion = meta.ManifestVersion,
            EntryPoint = meta.EntryPoint,
            IsPublic = true,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };
        await _db.MarketplaceSkills.InsertOneAsync(skill, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { item = ToDto(skill, userId) }));
    }

    // ======================================================================
    // 收藏 / 取消收藏
    // ======================================================================

    [HttpPost("{id}/favorite")]
    [RequireScope(ScopeRead)]
    public async Task<IActionResult> Favorite(string id, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var result = await _db.MarketplaceSkills.UpdateOneAsync(
            x => x.Id == id && x.IsPublic,
            Builders<MarketplaceSkill>.Update
                .AddToSet(x => x.FavoritedByUserIds, userId)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "技能不存在或已下架"));
        var skill = await _db.MarketplaceSkills.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { item = ToDto(skill!, userId) }));
    }

    [HttpPost("{id}/unfavorite")]
    [RequireScope(ScopeRead)]
    public async Task<IActionResult> Unfavorite(string id, CancellationToken ct)
    {
        var userId = GetBoundUserId();
        var result = await _db.MarketplaceSkills.UpdateOneAsync(
            x => x.Id == id,
            Builders<MarketplaceSkill>.Update
                .Pull(x => x.FavoritedByUserIds, userId)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "技能不存在"));
        var skill = await _db.MarketplaceSkills.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { item = ToDto(skill!, userId) }));
    }

    // ======================================================================
    // Helpers
    // ======================================================================

    /// <summary>
    /// 从 AgentApiKey 鉴权结果中取得绑定用户。
    /// 失败直接抛 <see cref="UnauthorizedAccessException"/>，由 ExceptionMiddleware 转 401。
    /// </summary>
    private string GetBoundUserId()
    {
        var id = User.FindFirst("boundUserId")?.Value;
        if (string.IsNullOrWhiteSpace(id))
            throw new UnauthorizedAccessException("Missing boundUserId claim");
        return id;
    }

    private static List<string> ParseTags(string? tagsJson)
    {
        if (string.IsNullOrWhiteSpace(tagsJson)) return new List<string>();
        try
        {
            var parsed = JsonSerializer.Deserialize<List<string>>(tagsJson);
            if (parsed == null) return new List<string>();
            return parsed
                .Where(t => !string.IsNullOrWhiteSpace(t))
                .Select(t => TrimChars(t.Trim(), MaxTagLength))
                .Where(t => !string.IsNullOrEmpty(t))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(MaxTagsPerItem)
                .ToList();
        }
        catch { return new List<string>(); }
    }

    private static string SanitizeFileName(string name)
    {
        var cleaned = Regex.Replace(name ?? string.Empty, "[^A-Za-z0-9._-]", "_");
        if (string.IsNullOrEmpty(cleaned)) cleaned = "skill.zip";
        if (cleaned.Length > 100) cleaned = cleaned[..100];
        return cleaned;
    }

    private static string TrimChars(string s, int maxLen)
    {
        if (string.IsNullOrEmpty(s)) return string.Empty;
        return s.Length <= maxLen ? s : s[..maxLen];
    }

    private static object ToDto(MarketplaceSkill s, string currentUserId)
    {
        return new
        {
            s.Id,
            s.Title,
            s.Description,
            iconEmoji = s.IconEmoji,
            coverImageUrl = s.CoverImageUrl,
            previewUrl = s.PreviewUrl,
            tags = s.Tags ?? new List<string>(),
            zipUrl = s.ZipUrl,
            zipSizeBytes = s.ZipSizeBytes,
            originalFileName = s.OriginalFileName,
            hasSkillMd = s.HasSkillMd,
            downloadCount = s.DownloadCount,
            favoriteCount = s.FavoritedByUserIds?.Count ?? 0,
            isFavoritedByCurrentUser = s.FavoritedByUserIds?.Contains(currentUserId) ?? false,
            ownerUserId = s.OwnerUserId,
            ownerUserName = string.IsNullOrWhiteSpace(s.AuthorName) ? "未知用户" : s.AuthorName,
            createdAt = s.CreatedAt,
            updatedAt = s.UpdatedAt
        };
    }
}
