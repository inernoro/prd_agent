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
    private readonly IConfiguration _config;
    private readonly ILogger<MarketplaceSkillsOpenApiController> _logger;

    public MarketplaceSkillsOpenApiController(
        MongoDbContext db,
        IAssetStorage assetStorage,
        SkillZipMetadataExtractor zipExtractor,
        IConfiguration config,
        ILogger<MarketplaceSkillsOpenApiController> logger)
    {
        _db = db;
        _config = config;
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

        // 官方条目要占 1 格 → 从 DB 少查 1 条，保证总长严格 <= limit，尊重 AI 分页契约
        var willInject = OfficialMarketplaceSkillInjector.ShouldInject(keyword, tag);
        var dbLimit = willInject ? Math.Max(resolvedLimit - 1, 0) : resolvedLimit;

        var items = dbLimit > 0
            ? await query.Limit(dbLimit).ToListAsync(ct)
            : new List<MarketplaceSkill>();
        var dtos = items.Select(s => ToDto(s, userId)).Cast<object>().ToList();

        // 虚拟注入官方 findmapskills 到首位 —— AI 搜 `findmapskills` / `海鲜市场` 就能直接发现
        if (willInject)
        {
            dtos.Insert(0, OfficialMarketplaceSkillInjector.BuildFindMapSkillsDto(Request, _config, userId));
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
            return Ok(ApiResponse<object>.Ok(new { item = OfficialMarketplaceSkillInjector.BuildFindMapSkillsDto(Request, _config, userId) }));
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
            return Ok(ApiResponse<object>.Ok(OfficialMarketplaceSkillInjector.BuildForkResponse(Request, _config, userId)));
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
        // === 2026-05-01 新增:幂等覆盖支持 ===
        // slug:同一用户用同一 slug 反复上传时走 upsert,避免市场堆积重复条目。
        //   优先级:form 显式 > SKILL.md frontmatter `name` > 空(走 always-new)
        // version:语义化版本号,只用于展示。
        //   优先级:form 显式 > SKILL.md frontmatter `version` > 旧版本 patch++
        // replaceMode:覆盖策略
        //   - "auto" (默认): slug 命中已有条目 → 覆盖;否则 insert
        //   - "always-new": 永远 insert(保留历史所有版本)
        //   - "strict": slug 命中已有条目 → 200 OK 但 replaced=true 提示;
        //               没命中也 insert
        [FromForm] string? slug,
        [FromForm] string? version,
        [FromForm] string? replaceMode,
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

        // ── slug 解析(决定 upsert key)──
        // 用户显式 form > SKILL.md frontmatter `name` > 空
        var rawSlug = !string.IsNullOrWhiteSpace(slug) ? slug : meta.FrontmatterName;
        var finalSlug = string.IsNullOrWhiteSpace(rawSlug) ? null : NormalizeSlug(rawSlug);

        // ── 决定走 upsert 还是 insert ──
        // 命中策略(2026-05-01,处理"老条目没 Slug"的迁移场景):
        //   1. 优先按 (ownerUserId, Slug) 严格匹配 — 这是 v1.1+ 上传的条目都会命中
        //   2. 若没命中,且 caller 提供了 title,fallback 按 (ownerUserId, Title) 命中
        //      这一步专为旧 v1.0 时代的条目设计:它们 Slug=null,但 Title 一致就该被覆盖
        //      回写时把 Slug 字段补上,后续上传走严格路径
        // mode=always-new 跳过整个 upsert
        var mode = (replaceMode ?? "auto").Trim().ToLowerInvariant();
        MarketplaceSkill? existing = null;
        if (mode != "always-new")
        {
            if (!string.IsNullOrEmpty(finalSlug))
            {
                existing = await _db.MarketplaceSkills
                    .Find(x => x.OwnerUserId == userId && x.Slug == finalSlug)
                    .FirstOrDefaultAsync(ct);
            }

            // Title fallback:slug 没命中,但调用方传了 title 或 zip 文件名兜底,
            // 看是否有同 owner + 同 title 但 slug 仍为 null 的旧条目。
            if (existing == null && !string.IsNullOrWhiteSpace(title))
            {
                var trimmedTitle = title.Trim();
                existing = await _db.MarketplaceSkills
                    .Find(x => x.OwnerUserId == userId
                            && (x.Slug == null || x.Slug == "")
                            && x.Title == trimmedTitle)
                    .FirstOrDefaultAsync(ct);
            }
        }

        var id = existing?.Id ?? Guid.NewGuid().ToString("N");
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
            string.IsNullOrWhiteSpace(title) ? (existing?.Title ?? Path.GetFileNameWithoutExtension(file.FileName)) : title.Trim(),
            TitleMaxChars);
        if (string.IsNullOrWhiteSpace(finalTitle)) finalTitle = "未命名技能";

        var finalDescription = TrimChars(
            string.IsNullOrWhiteSpace(description) ? (existing?.Description ?? finalTitle) : description.Trim(),
            DescriptionMaxChars);

        var tags = string.IsNullOrWhiteSpace(tagsJson) && existing != null
            ? existing.Tags
            : ParseTags(tagsJson);
        var finalIcon = string.IsNullOrWhiteSpace(iconEmoji)
            ? (existing?.IconEmoji ?? "🧩")
            : iconEmoji.Trim();
        if (finalIcon.Length > 4) finalIcon = finalIcon[..4];

        // ── version 解析 ──
        // form > frontmatter > 已有版本 patch++ > "1.0.0"
        var finalVersion = !string.IsNullOrWhiteSpace(version) ? version!.Trim()
                         : !string.IsNullOrWhiteSpace(meta.FrontmatterVersion) ? meta.FrontmatterVersion!.Trim()
                         : BumpPatchVersion(existing?.Version);

        // 作者快照(覆盖时保留原作者快照,用 owner 兜底)
        var author = existing == null
            ? await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct)
            : null;
        var authorName = existing?.AuthorName ?? author?.DisplayName ?? author?.Username ?? "未知用户";
        var authorAvatar = existing?.AuthorAvatar ?? author?.AvatarFileName;

        if (existing == null)
        {
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
                Slug = finalSlug,
                Version = finalVersion,
                IsPublic = true,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow
            };
            await _db.MarketplaceSkills.InsertOneAsync(skill, cancellationToken: ct);
            return Ok(ApiResponse<object>.Ok(new
            {
                item = ToDto(skill, userId),
                replaced = false,
                slug = finalSlug,
                version = finalVersion,
            }));
        }

        // ── 覆盖路径(strict 模式仍走更新,但 response 标记需要用户确认)──
        // 注意旧 ZipKey 不立即删:让 CDN 缓存自然过期 + 后续 GC 任务清理。
        // 这里保留 CreatedAt / DownloadCount / FavoritedByUserIds / OwnerUserId 不变。
        var update = Builders<MarketplaceSkill>.Update
            .Set(x => x.Title, finalTitle)
            .Set(x => x.Description, finalDescription)
            .Set(x => x.IconEmoji, finalIcon)
            .Set(x => x.Tags, tags)
            .Set(x => x.ZipKey, key)
            .Set(x => x.ZipUrl, zipUrl)
            .Set(x => x.ZipSizeBytes, bytes.LongLength)
            .Set(x => x.OriginalFileName, file.FileName)
            .Set(x => x.HasSkillMd, meta.HasSkillMd)
            .Set(x => x.SkillMdPreview, meta.SkillMdPreview)
            .Set(x => x.ManifestVersion, meta.ManifestVersion)
            .Set(x => x.EntryPoint, meta.EntryPoint)
            .Set(x => x.Slug, finalSlug)
            .Set(x => x.Version, finalVersion)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        await _db.MarketplaceSkills.UpdateOneAsync(x => x.Id == existing.Id, update, cancellationToken: ct);

        var refreshed = await _db.MarketplaceSkills.Find(x => x.Id == existing.Id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            item = ToDto(refreshed!, userId),
            replaced = true,
            slug = finalSlug,
            version = finalVersion,
            previousVersion = existing.Version,
        }));
    }

    /// <summary>把任意输入归一化成稳定 slug:小写 + 只保留 [a-z0-9-]。</summary>
    private static string NormalizeSlug(string raw)
    {
        var sb = new System.Text.StringBuilder(raw.Length);
        foreach (var ch in raw.Trim().ToLowerInvariant())
        {
            if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-')
                sb.Append(ch);
            else if (ch == '_' || ch == ' ' || ch == '.')
                sb.Append('-');
            // 其它字符直接丢弃(中文 / 标点 / emoji)
        }
        var s = sb.ToString().Trim('-');
        // 合并连续 -
        while (s.Contains("--")) s = s.Replace("--", "-");
        return string.IsNullOrEmpty(s) ? "skill" : s[..Math.Min(s.Length, 60)];
    }

    /// <summary>1.2.3 → 1.2.4;非法 / 空 → "1.0.0"。</summary>
    private static string BumpPatchVersion(string? prev)
    {
        if (string.IsNullOrWhiteSpace(prev)) return "1.0.0";
        var parts = prev.Trim().Split('.');
        if (parts.Length != 3) return "1.0.0";
        if (!int.TryParse(parts[0], out var major)) return "1.0.0";
        if (!int.TryParse(parts[1], out var minor)) return "1.0.0";
        if (!int.TryParse(parts[2], out var patch)) return "1.0.0";
        return $"{major}.{minor}.{patch + 1}";
    }

    // ======================================================================
    // 删除（仅作者，2026-05-01 新增）
    // 让 AI 上传错时能自助清理,无需用户去 UI 操作。
    // ======================================================================

    [HttpDelete("{id}")]
    [RequireScope(ScopeWrite)]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var userId = GetBoundUserId();

        // 官方虚拟条目不允许删除
        if (OfficialMarketplaceSkillInjector.IsOfficialId(id))
            return BadRequest(ApiResponse<object>.Fail("CANNOT_DELETE_OFFICIAL", "官方条目不可删除"));

        var skill = await _db.MarketplaceSkills.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (skill == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "技能不存在"));
        if (skill.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "仅作者可删除"));

        try { await _assetStorage.DeleteByKeyAsync(skill.ZipKey, ct); }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[OpenApi] MarketplaceSkill 删除对象存储 zip 失败 key={Key}", skill.ZipKey);
        }

        if (!string.IsNullOrWhiteSpace(skill.CoverImageKey))
        {
            try { await _assetStorage.DeleteByKeyAsync(skill.CoverImageKey!, ct); }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[OpenApi] MarketplaceSkill 删除封面失败 key={Key}", skill.CoverImageKey);
            }
        }

        await _db.MarketplaceSkills.DeleteOneAsync(x => x.Id == id, ct);
        return Ok(ApiResponse<object>.Ok(new { id, deleted = true }));
    }

    // ======================================================================
    // 收藏 / 取消收藏
    // ======================================================================

    [HttpPost("{id}/favorite")]
    [RequireScope(ScopeRead)]
    public async Task<IActionResult> Favorite(string id, CancellationToken ct)
    {
        var userId = GetBoundUserId();

        // 官方虚拟条目：幂等 no-op，和 Fork / GetById 分支保持对称
        if (OfficialMarketplaceSkillInjector.IsOfficialId(id))
            return Ok(ApiResponse<object>.Ok(new { item = OfficialMarketplaceSkillInjector.BuildFindMapSkillsDto(Request, _config, userId) }));

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

        // 官方虚拟条目：同上幂等 no-op
        if (OfficialMarketplaceSkillInjector.IsOfficialId(id))
            return Ok(ApiResponse<object>.Ok(new { item = OfficialMarketplaceSkillInjector.BuildFindMapSkillsDto(Request, _config, userId) }));

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
            // 2026-05-01:幂等覆盖与版本展示字段
            slug = s.Slug,
            version = s.Version,
            createdAt = s.CreatedAt,
            updatedAt = s.UpdatedAt
        };
    }
}
