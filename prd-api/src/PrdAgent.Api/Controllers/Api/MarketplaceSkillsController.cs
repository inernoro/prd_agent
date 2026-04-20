using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Infrastructure.Services.MarketplaceSkills;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 海鲜市场「技能」板块：用户上传 zip 技能包、浏览、下载、收藏。
/// v1 不执行 zip，仅做社区分享；字段预留供未来接入执行引擎。
/// </summary>
[ApiController]
[Route("api/marketplace/skills")]
[Authorize]
public class MarketplaceSkillsController : ControllerBase
{
    private const long MaxZipBytes = 20L * 1024 * 1024;
    private const int SummaryMaxChars = 30;
    private const int DescriptionMaxChars = 200;
    private const int TitleMaxChars = 80;
    private const int MaxTagsPerItem = 10;
    private const int MaxTagLength = 20;

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IAssetStorage _assetStorage;
    private readonly SkillZipMetadataExtractor _zipExtractor;
    private readonly ILogger<MarketplaceSkillsController> _logger;

    public MarketplaceSkillsController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        IAssetStorage assetStorage,
        SkillZipMetadataExtractor zipExtractor,
        ILogger<MarketplaceSkillsController> logger)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _assetStorage = assetStorage;
        _zipExtractor = zipExtractor;
        _logger = logger;
    }

    // ======================================================================
    // 列表
    // ======================================================================

    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? keyword,
        [FromQuery] string? sort,
        [FromQuery] string? tag,
        CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();

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
        {
            filter = builder.And(filter, builder.AnyEq(x => x.Tags, tag.Trim()));
        }

        var query = _db.MarketplaceSkills.Find(filter);
        query = sort switch
        {
            "new" => query.SortByDescending(x => x.CreatedAt),
            _ => query.SortByDescending(x => x.DownloadCount).ThenByDescending(x => x.CreatedAt)
        };

        var items = await query.Limit(200).ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items = items.Select(s => ToDto(s, userId)) }));
    }

    /// <summary>
    /// 当前用户收藏的技能列表（供「我的空间 → 我收藏的技能」区块消费）
    /// </summary>
    [HttpGet("favorites")]
    public async Task<IActionResult> MyFavorites(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var items = await _db.MarketplaceSkills
            .Find(x => x.IsPublic && x.FavoritedByUserIds.Contains(userId))
            .SortByDescending(x => x.UpdatedAt)
            .Limit(50)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items = items.Select(s => ToDto(s, userId)) }));
    }

    [HttpGet("tags")]
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
    // 上传
    // ======================================================================

    /// <summary>
    /// 上传 zip 技能包到海鲜市场。
    /// - 标题为空 → 用文件名（去扩展名）兜底
    /// - 详情为空 且 zip 内有 SKILL.md → 调 LLM 生成 30 字摘要；都失败则回退到标题
    /// - 标签来自用户自定义（JSON 数组字符串），最多 10 个
    /// </summary>
    [HttpPost("upload")]
    [RequestSizeLimit(MaxZipBytes)]
    public async Task<IActionResult> Upload(
        [FromForm] IFormFile file,
        [FromForm] string? title,
        [FromForm] string? description,
        [FromForm] string? iconEmoji,
        [FromForm] string? tagsJson,
        CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();

        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FILE", "请选择要上传的 zip 技能包"));
        if (file.Length > MaxZipBytes)
            return BadRequest(ApiResponse<object>.Fail("FILE_TOO_LARGE", $"文件大小不能超过 {MaxZipBytes / 1024 / 1024}MB"));

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (ext != ".zip")
            return BadRequest(ApiResponse<object>.Fail("INVALID_FILE", "仅支持 .zip 格式的技能包"));

        // 读 zip 到内存（上限 20MB 可接受）
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct);
        var bytes = ms.ToArray();

        // 解析 SKILL.md
        var meta = _zipExtractor.Extract(bytes);
        if (!string.IsNullOrEmpty(meta.Error))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FILE", $"压缩包解析失败: {meta.Error}"));

        // 生成 ID、上传到 COS / R2
        var id = Guid.NewGuid().ToString("N");
        var safeName = SanitizeFileName(file.FileName);
        var key = $"marketplace-skills/{id}/{safeName}";
        try
        {
            await _assetStorage.UploadToKeyAsync(key, bytes, "application/zip", ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "MarketplaceSkill 上传对象存储失败 userId={UserId} key={Key}", userId, key);
            return StatusCode(500, ApiResponse<object>.Fail("UPLOAD_FAILED", "上传到存储失败，请稍后重试"));
        }
        var zipUrl = _assetStorage.BuildUrlForKey(key);

        // 字段兜底
        var finalTitle = TrimChars(
            string.IsNullOrWhiteSpace(title) ? Path.GetFileNameWithoutExtension(file.FileName) : title.Trim(),
            TitleMaxChars);
        if (string.IsNullOrWhiteSpace(finalTitle))
            finalTitle = "未命名技能";

        var finalDescription = (description ?? "").Trim();
        if (string.IsNullOrEmpty(finalDescription) && meta.HasSkillMd && !string.IsNullOrWhiteSpace(meta.SkillMdContent))
        {
            try
            {
                finalDescription = await GenerateSummaryAsync(userId, meta.SkillMdContent!, ct);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "MarketplaceSkill 自动摘要失败 userId={UserId} id={Id}", userId, id);
            }
        }
        if (string.IsNullOrWhiteSpace(finalDescription))
            finalDescription = finalTitle;
        finalDescription = TrimChars(finalDescription, DescriptionMaxChars);

        var tags = ParseTags(tagsJson);
        var finalIcon = string.IsNullOrWhiteSpace(iconEmoji) ? "🧩" : iconEmoji.Trim();
        if (finalIcon.Length > 4) finalIcon = finalIcon[..4]; // emoji 至多 4 字符

        // 作者快照
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
    // 下载（对应 IMarketplaceItem.fork 语义：计数 +1 + 返回下载 URL）
    // ======================================================================

    [HttpPost("{id}/fork")]
    public async Task<IActionResult> Fork(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var skill = await _db.MarketplaceSkills.Find(x => x.Id == id && x.IsPublic).FirstOrDefaultAsync(ct);
        if (skill == null)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "技能不存在或已下架"));

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
    // 收藏 / 取消收藏
    // ======================================================================

    [HttpPost("{id}/favorite")]
    public async Task<IActionResult> Favorite(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var result = await _db.MarketplaceSkills.UpdateOneAsync(
            x => x.Id == id && x.IsPublic,
            Builders<MarketplaceSkill>.Update
                .AddToSet(x => x.FavoritedByUserIds, userId)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "技能不存在或已下架"));

        var skill = await _db.MarketplaceSkills.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { item = ToDto(skill!, userId) }));
    }

    [HttpPost("{id}/unfavorite")]
    public async Task<IActionResult> Unfavorite(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var result = await _db.MarketplaceSkills.UpdateOneAsync(
            x => x.Id == id,
            Builders<MarketplaceSkill>.Update
                .Pull(x => x.FavoritedByUserIds, userId)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "技能不存在"));

        var skill = await _db.MarketplaceSkills.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { item = ToDto(skill!, userId) }));
    }

    // ======================================================================
    // 删除（仅作者）
    // ======================================================================

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var skill = await _db.MarketplaceSkills.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (skill == null)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "技能不存在"));
        if (skill.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "仅作者可删除"));

        try
        {
            await _assetStorage.DeleteByKeyAsync(skill.ZipKey, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "MarketplaceSkill 删除对象失败 key={Key}", skill.ZipKey);
        }

        await _db.MarketplaceSkills.DeleteOneAsync(x => x.Id == id, ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ======================================================================
    // Helpers
    // ======================================================================

    private async Task<string> GenerateSummaryAsync(string userId, string skillMdContent, CancellationToken ct)
    {
        const string appCallerCode = "marketplace-skill.summary::chat";
        var content = skillMdContent.Length > 2000 ? skillMdContent[..2000] : skillMdContent;

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: content.Length,
            DocumentHash: null,
            SystemPromptRedacted: "marketplace-skill-summary",
            RequestType: "chat",
            AppCallerCode: appCallerCode));

        var requestBody = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject
                {
                    ["role"] = "system",
                    ["content"] = "你是技能摘要助手。阅读用户提供的 SKILL.md 文件，用不超过 30 个汉字（或 30 字符）概括该技能的核心用途。直接输出摘要，不要引号、不要额外说明、不要换行。"
                },
                new JsonObject
                {
                    ["role"] = "user",
                    ["content"] = content
                }
            },
            ["temperature"] = 0.3,
            ["max_tokens"] = 120
        };

        var response = await _gateway.SendAsync(new GatewayRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = "chat",
            RequestBody = requestBody
        }, ct);

        if (!response.Success || string.IsNullOrWhiteSpace(response.Content))
            return string.Empty;

        var summary = response.Content!
            .Trim()
            .Trim('"', '\'', '\u201C', '\u201D')
            .Replace("\r", " ")
            .Replace("\n", " ")
            .Trim();
        return TrimChars(summary, SummaryMaxChars);
    }

    private static List<string> ParseTags(string? tagsJson)
    {
        if (string.IsNullOrWhiteSpace(tagsJson))
            return new List<string>();
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
        catch
        {
            return new List<string>();
        }
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
            tags = s.Tags ?? new List<string>(),
            zipUrl = s.ZipUrl,
            zipSizeBytes = s.ZipSizeBytes,
            originalFileName = s.OriginalFileName,
            hasSkillMd = s.HasSkillMd,
            downloadCount = s.DownloadCount,
            favoriteCount = s.FavoritedByUserIds?.Count ?? 0,
            isFavoritedByCurrentUser = s.FavoritedByUserIds?.Contains(currentUserId) ?? false,
            // 映射到 MarketplaceItemBase 约定，兼容前端通用卡片
            forkCount = s.DownloadCount,
            ownerUserId = s.OwnerUserId,
            ownerUserName = string.IsNullOrWhiteSpace(s.AuthorName) ? "未知用户" : s.AuthorName,
            ownerUserAvatar = s.AuthorAvatar,
            createdAt = s.CreatedAt,
            updatedAt = s.UpdatedAt,
        };
    }
}
