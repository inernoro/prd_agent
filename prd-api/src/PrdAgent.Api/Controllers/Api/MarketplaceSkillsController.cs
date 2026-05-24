using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Text.Unicode;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using PrdAgent.Api.Controllers.Api.OfficialSkills;
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
    private const long MaxCoverBytes = 5L * 1024 * 1024;
    private const int SummaryMaxChars = 30;
    private const int DescriptionMaxChars = 200;
    private const int TitleMaxChars = 80;
    private const int MaxTagsPerItem = 10;
    private const int MaxTagLength = 20;
    private const int PreviewUrlMaxLen = 512;

    private static readonly HashSet<string> AllowedCoverExts = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".webp", ".gif"
    };

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IAssetStorage _assetStorage;
    private readonly SkillZipMetadataExtractor _zipExtractor;
    private readonly IConfiguration _config;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<MarketplaceSkillsController> _logger;

    public MarketplaceSkillsController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        IAssetStorage assetStorage,
        SkillZipMetadataExtractor zipExtractor,
        IConfiguration config,
        IHttpClientFactory httpClientFactory,
        ILogger<MarketplaceSkillsController> logger)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _assetStorage = assetStorage;
        _zipExtractor = zipExtractor;
        _config = config;
        _httpClientFactory = httpClientFactory;
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

        // 官方条目（findmapskills + 目录技能，按 keyword/tag 过滤）永远置顶
        // Web：无搜索词也展示全部官方（前端归到「官方推荐」独立行，不挤社区瀑布流）
        var officialDtos = OfficialMarketplaceSkillInjector.BuildAllDtos(Request, _config, userId, keyword, tag, includeCatalogWhenUnfiltered: true);
        // 官方占位 → 从 DB 少查对应条数，保证总长 <= 200 硬上限
        var dbLimit = Math.Max(200 - officialDtos.Count, 0);

        var items = await query.Limit(dbLimit).ToListAsync(ct);
        var dtos = items.Select(s => ToDto(s, userId)).Cast<object>().ToList();

        dtos.InsertRange(0, officialDtos);

        return Ok(ApiResponse<object>.Ok(new { items = dtos }));
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

        // 合并官方目录的 tag（含「精英」「开放接口」等），否则官方专属 tag 不在筛选标签云里，
        // 用户没法按「精英」筛出 laowang。findmapskills 的 tag 一并并入。
        var officialTags = OfficialSkillCatalog.All.SelectMany(e => e.Tags ?? new List<string>())
            .Concat(new[] { "精英", "技能", "开放接口" });

        var distinct = allTags
            .SelectMany(x => x ?? new List<string>())
            .Concat(officialTags)
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
    // Zip 同源代理（详情弹窗在线预览）
    // ======================================================================

    /// <summary>
    /// 通过后端代理转发技能 zip,让浏览器在同源下解压预览,避开 COS/R2 公链的 CORS 限制。
    /// 直链 download 仍走 skill.zipUrl(用户点「下载」时浏览器自己跳转,不受 CORS 影响)。
    /// 仅供预览场景的 JSZip 解压使用,不替代 zipUrl 字段。
    /// </summary>
    [HttpGet("{id}/zip-content")]
    public async Task<IActionResult> ZipContent(string id, CancellationToken ct)
    {
        var skill = await _db.MarketplaceSkills
            .Find(x => x.Id == id && x.IsPublic)
            .FirstOrDefaultAsync(ct);
        if (skill == null || string.IsNullOrEmpty(skill.ZipUrl))
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "技能不存在或已下架"));

        return await ProxyZipAsync(skill.ZipUrl, skill.OriginalFileName, ct);
    }

    /// <summary>
    /// 公开分享版本的 zip 代理:用 share token 鉴权,匹配 ViewShare 端点的 AllowAnonymous 语义。
    /// </summary>
    [HttpGet("public/skill-share/{token}/zip-content")]
    [AllowAnonymous]
    public async Task<IActionResult> ZipContentByShareToken(string token, CancellationToken ct)
    {
        var link = await _db.MarketplaceSkillShareLinks.Find(l => l.Token == token).FirstOrDefaultAsync(ct);
        if (link == null || link.IsRevoked)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "分享链接不存在或已撤销"));
        if (link.ExpiresAt.HasValue && link.ExpiresAt.Value < DateTime.UtcNow)
            return NotFound(ApiResponse<object>.Fail("EXPIRED", "分享链接已过期"));

        var skill = await _db.MarketplaceSkills
            .Find(x => x.Id == link.SkillId && x.IsPublic)
            .FirstOrDefaultAsync(ct);
        if (skill == null || string.IsNullOrEmpty(skill.ZipUrl))
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "关联技能已删除或下架"));

        return await ProxyZipAsync(skill.ZipUrl, skill.OriginalFileName, ct);
    }

    private async Task<IActionResult> ProxyZipAsync(string sourceUrl, string? originalFileName, CancellationToken ct)
    {
        try
        {
            var http = _httpClientFactory.CreateClient();
            http.Timeout = TimeSpan.FromSeconds(30);
            var upstream = await http.GetAsync(sourceUrl, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!upstream.IsSuccessStatusCode)
            {
                _logger.LogWarning("[MarketplaceSkills] zip 代理失败 status={Status} url={Url}",
                    upstream.StatusCode, sourceUrl);
                return StatusCode(502, ApiResponse<object>.Fail("UPSTREAM_FETCH_FAILED",
                    $"从存储下载 zip 失败 (HTTP {(int)upstream.StatusCode})"));
            }
            var stream = await upstream.Content.ReadAsStreamAsync(ct);
            var fileName = string.IsNullOrWhiteSpace(originalFileName) ? "skill.zip" : originalFileName;
            return File(stream, "application/zip", fileName, enableRangeProcessing: false);
        }
        catch (TaskCanceledException) when (ct.IsCancellationRequested)
        {
            return new EmptyResult();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[MarketplaceSkills] zip 代理异常");
            return StatusCode(502, ApiResponse<object>.Fail("UPSTREAM_FETCH_FAILED", "下载源 zip 时发生错误"));
        }
    }

    // ======================================================================
    // AI 详情起草（SSE 流式）
    // ======================================================================

    /// <summary>
    /// 拖拽上传时前端调用：读 SKILL.md 内容 → SSE 流式回吐 30 字摘要。
    /// 目的是「前几秒就有字」：用 chat 模型 + max_tokens=120，token 一到就 flush，
    /// 用户在拖入文件后立刻看见详情逐字浮现，不会面对空白。
    /// 详情留空时上传接口仍会兜底，本端点纯属"预填体验"加速。
    /// </summary>
    public sealed class DraftDescriptionRequest
    {
        public string? Content { get; set; }
        public string? FileName { get; set; }
    }

    [HttpPost("draft-description")]
    public async Task DraftDescription([FromBody] DraftDescriptionRequest? request, CancellationToken ct)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        var jsonOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            // 不要把中文转成 \uXXXX；UTF-8 原样输出，前端日志和用户提示都好读
            Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
        };

        async Task WriteSseAsync(string ev, object data)
        {
            try
            {
                var json = JsonSerializer.Serialize(data, jsonOptions);
                await Response.WriteAsync($"event: {ev}\n", ct);
                await Response.WriteAsync($"data: {json}\n\n", ct);
                await Response.Body.FlushAsync(ct);
            }
            catch { /* 客户端已断 */ }
        }

        async Task WriteDeltaAsync(string text)
        {
            try
            {
                // 直接以 \n 分隔的 SSE data 行，便于前端简单拼接（前端按 \n\n 切事件，再读 data:）
                foreach (var line in text.Split('\n'))
                {
                    await Response.WriteAsync($"data: {line}\n", ct);
                }
                await Response.WriteAsync("\n", ct);
                await Response.Body.FlushAsync(ct);
            }
            catch { /* 客户端已断 */ }
        }

        var content = (request?.Content ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(content))
        {
            await WriteSseAsync("error", new { message = "SKILL.md 内容为空" });
            return;
        }
        if (content.Length > 2000) content = content[..2000];

        var userId = this.GetRequiredUserId();
        const string appCallerCode = AppCallerRegistry.MarketplaceSkill.DraftDescription;

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: content.Length,
            DocumentHash: null,
            SystemPromptRedacted: "marketplace-skill-draft-description",
            RequestType: "chat",
            AppCallerCode: appCallerCode));

        // 提示词重点：第一句就要是结论，token-by-token 用户就能看到答案在生成
        var systemPrompt =
            "你是技能市场的卡片文案助手。读完用户提供的 SKILL.md，用 30 个字以内一句话直接说明"
            + "这个技能解决什么问题、能做什么。要求："
            + "(1) 不要任何前缀（不要『这是…』『该技能…』）直接给名词性陈述；"
            + "(2) 一行成稿，不要换行、不要句号；"
            + "(3) 中文为主，保留必要英文术语；"
            + "(4) 严禁 emoji、引号、Markdown 标记。";

        var requestBody = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = content },
            },
            ["temperature"] = 0.2,
            ["max_tokens"] = 120,
        };

        var emittedAny = false;
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(new GatewayRequest
            {
                AppCallerCode = appCallerCode,
                ModelType = "chat",
                RequestBody = requestBody,
            }, CancellationToken.None))
            {
                if (ct.IsCancellationRequested) break;
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    emittedAny = true;
                    await WriteDeltaAsync(chunk.Content);
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    await WriteSseAsync("error", new { message = chunk.Error ?? "模型返回错误" });
                    return;
                }
                else if (chunk.Type == GatewayChunkType.Done)
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // 客户端断开，安静退出
            return;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[MarketplaceSkills] draft-description 流失败");
            await WriteSseAsync("error", new { message = "AI 起草失败，可以手动填写" });
            return;
        }

        if (!emittedAny)
        {
            await WriteSseAsync("error", new { message = "未生成内容" });
            return;
        }

        try
        {
            await Response.WriteAsync("event: done\ndata: [DONE]\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }
        catch { /* ignore */ }
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
    [RequestSizeLimit(MaxZipBytes + MaxCoverBytes + 1024 * 1024)]
    public async Task<IActionResult> Upload(
        [FromForm] IFormFile file,
        [FromForm] string? title,
        [FromForm] string? description,
        [FromForm] string? iconEmoji,
        [FromForm] string? tagsJson,
        [FromForm] IFormFile? coverImage,
        [FromForm] string? previewUrl,
        [FromForm] string? previewSource,
        [FromForm] string? previewHostedSiteId,
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

        // 校验封面图（可选）
        if (coverImage != null && coverImage.Length > 0)
        {
            if (coverImage.Length > MaxCoverBytes)
                return BadRequest(ApiResponse<object>.Fail("COVER_TOO_LARGE", $"封面图不能超过 {MaxCoverBytes / 1024 / 1024}MB"));
            var coverExt = Path.GetExtension(coverImage.FileName).ToLowerInvariant();
            if (!AllowedCoverExts.Contains(coverExt))
                return BadRequest(ApiResponse<object>.Fail("INVALID_COVER", "封面图仅支持 png/jpg/jpeg/webp/gif"));
            if (!string.IsNullOrWhiteSpace(coverImage.ContentType) &&
                !coverImage.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
                return BadRequest(ApiResponse<object>.Fail("INVALID_COVER", "封面图必须是图片类型"));
        }

        // 校验预览地址（可选）
        var (resolvedPreviewUrl, resolvedPreviewSource, resolvedPreviewHostedSiteId, previewError) =
            await ResolvePreviewAsync(userId, previewUrl, previewSource, previewHostedSiteId, ct);
        if (previewError != null)
            return BadRequest(ApiResponse<object>.Fail("INVALID_PREVIEW", previewError));

        // 读 zip 到内存（上限 20MB 可接受）
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct);
        var bytes = ms.ToArray();

        // 解析 SKILL.md
        var meta = _zipExtractor.Extract(bytes);
        if (!string.IsNullOrEmpty(meta.Error))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FILE", $"压缩包解析失败: {meta.Error}"));

        // 生成 ID、上传 zip 到 COS / R2
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

        // 上传封面图（若有）
        string? coverUrl = null;
        string? coverKey = null;
        if (coverImage != null && coverImage.Length > 0)
        {
            try
            {
                using var coverMs = new MemoryStream();
                await coverImage.CopyToAsync(coverMs, ct);
                var coverBytes = coverMs.ToArray();
                var coverExt = Path.GetExtension(coverImage.FileName).ToLowerInvariant();
                coverKey = $"marketplace-skills/{id}/cover{coverExt}";
                var coverMime = string.IsNullOrWhiteSpace(coverImage.ContentType)
                    ? GuessImageMime(coverExt)
                    : coverImage.ContentType;
                await _assetStorage.UploadToKeyAsync(coverKey, coverBytes, coverMime, ct);
                coverUrl = _assetStorage.BuildUrlForKey(coverKey);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "MarketplaceSkill 封面图上传失败 userId={UserId} id={Id}", userId, id);
                coverUrl = null;
                coverKey = null;
            }
        }

        // 字段兜底：标题
        var finalTitle = TrimChars(
            string.IsNullOrWhiteSpace(title) ? Path.GetFileNameWithoutExtension(file.FileName) : title.Trim(),
            TitleMaxChars);
        if (string.IsNullOrWhiteSpace(finalTitle))
            finalTitle = "未命名技能";

        // 字段兜底：描述 — 先用户输入 → 规则提取 SKILL.md → LLM 摘要 → 标题
        var finalDescription = (description ?? "").Trim();
        if (string.IsNullOrEmpty(finalDescription) && meta.HasSkillMd && !string.IsNullOrWhiteSpace(meta.SkillMdContent))
        {
            finalDescription = ExtractDescriptionByRule(meta.SkillMdContent!);
            if (string.IsNullOrWhiteSpace(finalDescription))
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
            CoverImageUrl = coverUrl,
            CoverImageKey = coverKey,
            PreviewUrl = resolvedPreviewUrl,
            PreviewSource = resolvedPreviewSource,
            PreviewHostedSiteId = resolvedPreviewHostedSiteId,
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

    /// <summary>
    /// 修改自己上传的市场技能元信息。
    /// 仅允许作者修改展示层字段；zip 包本体仍通过重新上传产生新条目，避免下载历史和包内容被静默替换。
    /// </summary>
    [HttpPatch("{id}")]
    [RequestSizeLimit(MaxCoverBytes + 1024 * 1024)]
    public async Task<IActionResult> Update(
        string id,
        [FromForm] string? title,
        [FromForm] string? description,
        [FromForm] string? iconEmoji,
        [FromForm] string? tagsJson,
        [FromForm] IFormFile? coverImage,
        [FromForm] bool? removeCover,
        [FromForm] string? previewUrl,
        [FromForm] string? previewSource,
        [FromForm] string? previewHostedSiteId,
        CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var skill = await _db.MarketplaceSkills.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (skill == null)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "技能不存在"));
        if (skill.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "仅作者可修改"));
        if (skill.ReferenceType != "zip")
            return BadRequest(ApiResponse<object>.Fail("NOT_EDITABLE", "该技能类型不支持修改"));

        if (coverImage != null && coverImage.Length > 0)
        {
            if (coverImage.Length > MaxCoverBytes)
                return BadRequest(ApiResponse<object>.Fail("COVER_TOO_LARGE", $"封面图不能超过 {MaxCoverBytes / 1024 / 1024}MB"));
            var coverExt = Path.GetExtension(coverImage.FileName).ToLowerInvariant();
            if (!AllowedCoverExts.Contains(coverExt))
                return BadRequest(ApiResponse<object>.Fail("INVALID_COVER", "封面图仅支持 png/jpg/jpeg/webp/gif"));
            if (!string.IsNullOrWhiteSpace(coverImage.ContentType) &&
                !coverImage.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
                return BadRequest(ApiResponse<object>.Fail("INVALID_COVER", "封面图必须是图片类型"));
        }

        var update = Builders<MarketplaceSkill>.Update
            .Set(x => x.Title, NormalizeTitle(title, skill.Title))
            .Set(x => x.Description, NormalizeDescription(description, skill.Description))
            .Set(x => x.IconEmoji, NormalizeIcon(iconEmoji, skill.IconEmoji))
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        if (tagsJson != null)
        {
            if (!TryParseTags(tagsJson, out var parsedTags))
                return BadRequest(ApiResponse<object>.Fail("INVALID_TAGS", "标签格式不正确"));
            update = update.Set(x => x.Tags, parsedTags);
        }

        var previewFieldsProvided = previewSource != null || previewUrl != null || previewHostedSiteId != null;
        if (previewFieldsProvided)
        {
            var (resolvedPreviewUrl, resolvedPreviewSource, resolvedPreviewHostedSiteId, previewError) =
                await ResolvePreviewAsync(userId, previewUrl, previewSource, previewHostedSiteId, ct);
            if (previewError != null)
                return BadRequest(ApiResponse<object>.Fail("INVALID_PREVIEW", previewError));

            update = update
                .Set(x => x.PreviewUrl, resolvedPreviewUrl)
                .Set(x => x.PreviewSource, resolvedPreviewSource)
                .Set(x => x.PreviewHostedSiteId, resolvedPreviewHostedSiteId);
        }

        var oldCoverKeyToDelete = string.Empty;
        if (removeCover == true)
        {
            oldCoverKeyToDelete = skill.CoverImageKey ?? string.Empty;
            update = update.Set(x => x.CoverImageUrl, null).Set(x => x.CoverImageKey, null);
            skill.CoverImageUrl = null;
            skill.CoverImageKey = null;
        }

        if (coverImage != null && coverImage.Length > 0)
        {
            try
            {
                using var coverMs = new MemoryStream();
                await coverImage.CopyToAsync(coverMs, ct);
                var coverBytes = coverMs.ToArray();
                var coverExt = Path.GetExtension(coverImage.FileName).ToLowerInvariant();
                var coverKey = $"marketplace-skills/{id}/cover{coverExt}";
                var coverMime = string.IsNullOrWhiteSpace(coverImage.ContentType)
                    ? GuessImageMime(coverExt)
                    : coverImage.ContentType;
                await _assetStorage.UploadToKeyAsync(coverKey, coverBytes, coverMime, ct);
                var coverUrl = _assetStorage.BuildUrlForKey(coverKey);
                if (!string.Equals(skill.CoverImageKey, coverKey, StringComparison.Ordinal))
                    oldCoverKeyToDelete = skill.CoverImageKey ?? oldCoverKeyToDelete;
                update = update.Set(x => x.CoverImageUrl, coverUrl).Set(x => x.CoverImageKey, coverKey);
                skill.CoverImageUrl = coverUrl;
                skill.CoverImageKey = coverKey;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "MarketplaceSkill 封面图更新失败 userId={UserId} id={Id}", userId, id);
                return StatusCode(500, ApiResponse<object>.Fail("UPLOAD_FAILED", "封面图上传失败，请稍后重试"));
            }
        }

        await _db.MarketplaceSkills.UpdateOneAsync(x => x.Id == id && x.OwnerUserId == userId, update, cancellationToken: ct);

        if (!string.IsNullOrWhiteSpace(oldCoverKeyToDelete) &&
            !string.Equals(oldCoverKeyToDelete, skill.CoverImageKey, StringComparison.Ordinal))
        {
            try
            {
                await _assetStorage.DeleteByKeyAsync(oldCoverKeyToDelete, ct);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "MarketplaceSkill 删除旧封面图失败 key={Key}", oldCoverKeyToDelete);
            }
        }

        var updated = await _db.MarketplaceSkills.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { item = ToDto(updated!, userId) }));
    }

    // ======================================================================
    // 下载（对应 IMarketplaceItem.fork 语义：计数 +1 + 返回下载 URL）
    // ======================================================================

    [HttpPost("{id}/fork")]
    public async Task<IActionResult> Fork(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();

        // 官方虚拟条目特判：不查 DB、不 +1 count，直接返回官方下载 URL（按 id 解析具体技能）
        if (OfficialMarketplaceSkillInjector.IsOfficialId(id))
        {
            var resp = OfficialMarketplaceSkillInjector.BuildForkResponseById(id, Request, _config, userId);
            if (resp == null)
                return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "官方技能不存在"));
            return Ok(ApiResponse<object>.Ok(resp));
        }

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

        // 官方虚拟条目：幂等 no-op，返回未变化的虚拟 DTO（按 id 解析具体技能）
        if (OfficialMarketplaceSkillInjector.IsOfficialId(id))
            return Ok(ApiResponse<object>.Ok(new { item = OfficialMarketplaceSkillInjector.BuildDtoById(id, Request, _config, userId) }));

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

        // 官方虚拟条目：同上幂等 no-op
        if (OfficialMarketplaceSkillInjector.IsOfficialId(id))
            return Ok(ApiResponse<object>.Ok(new { item = OfficialMarketplaceSkillInjector.BuildDtoById(id, Request, _config, userId) }));

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

        if (!string.IsNullOrWhiteSpace(skill.CoverImageKey))
        {
            try
            {
                await _assetStorage.DeleteByKeyAsync(skill.CoverImageKey!, ct);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "MarketplaceSkill 删除封面图失败 key={Key}", skill.CoverImageKey);
            }
        }

        await _db.MarketplaceSkills.DeleteOneAsync(x => x.Id == id, ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ======================================================================
    // 公开分享（免登录只读浏览技能包）
    // ======================================================================

    public sealed class CreateSkillShareRequest
    {
        /// <summary>有效天数；不传 = 永久</summary>
        public int? ExpiresInDays { get; set; }
    }

    [HttpPost("{id}/share")]
    public async Task<IActionResult> CreateShare(string id, [FromBody] CreateSkillShareRequest? body, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();

        if (OfficialMarketplaceSkillInjector.IsOfficialId(id))
            return BadRequest(ApiResponse<object>.Fail("NOT_SHAREABLE", "官方内置技能无需分享"));

        var skill = await _db.MarketplaceSkills.Find(x => x.Id == id && x.IsPublic).FirstOrDefaultAsync(ct);
        if (skill == null)
            return NotFound(ApiResponse<object>.Fail("DOCUMENT_NOT_FOUND", "技能不存在或已下架"));

        var author = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        var createdByName = author?.DisplayName ?? author?.Username ?? "未知用户";

        DateTime? expiresAt = null;
        if (body?.ExpiresInDays is int days && days > 0)
            expiresAt = DateTime.UtcNow.AddDays(Math.Min(days, 3650));

        var link = new MarketplaceSkillShareLink
        {
            SkillId = skill.Id,
            SkillTitle = skill.Title,
            CreatedBy = userId,
            CreatedByName = createdByName,
            ExpiresAt = expiresAt,
        };
        await _db.MarketplaceSkillShareLinks.InsertOneAsync(link, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            shareLink = new
            {
                token = link.Token,
                skillId = link.SkillId,
                skillTitle = link.SkillTitle,
                viewCount = link.ViewCount,
                createdByName = link.CreatedByName,
                createdAt = link.CreatedAt,
                expiresAt = link.ExpiresAt,
            },
            shareUrl = $"/s/skill/{link.Token}",
        }));
    }

    [HttpGet("public/skill-share/{token}")]
    [AllowAnonymous]
    public async Task<IActionResult> ViewShare(string token, CancellationToken ct)
    {
        var link = await _db.MarketplaceSkillShareLinks.Find(l => l.Token == token).FirstOrDefaultAsync(ct);
        if (link == null || link.IsRevoked)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "分享链接不存在或已撤销"));
        if (link.ExpiresAt.HasValue && link.ExpiresAt.Value < DateTime.UtcNow)
            return NotFound(ApiResponse<object>.Fail("EXPIRED", "分享链接已过期"));

        var skill = await _db.MarketplaceSkills.Find(x => x.Id == link.SkillId && x.IsPublic).FirstOrDefaultAsync(ct);
        if (skill == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "关联技能已删除或下架"));

        // 浏览计数 fire-and-forget（客户端断开不影响，server-authority 规则）
        _ = _db.MarketplaceSkillShareLinks.UpdateOneAsync(
            l => l.Id == link.Id,
            Builders<MarketplaceSkillShareLink>.Update
                .Inc(l => l.ViewCount, 1)
                .Set(l => l.LastViewedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new
        {
            token = link.Token,
            skillTitle = link.SkillTitle,
            createdByName = link.CreatedByName,
            skill = new
            {
                id = skill.Id,
                title = skill.Title,
                description = skill.Description,
                iconEmoji = skill.IconEmoji,
                coverImageUrl = skill.CoverImageUrl,
                tags = skill.Tags ?? new List<string>(),
                zipUrl = skill.ZipUrl,
                zipSizeBytes = skill.ZipSizeBytes,
                originalFileName = skill.OriginalFileName,
                hasSkillMd = skill.HasSkillMd,
            },
        }));
    }

    // ======================================================================
    // Helpers
    // ======================================================================

    private async Task<string> GenerateSummaryAsync(string userId, string skillMdContent, CancellationToken ct)
    {
        const string appCallerCode = AppCallerRegistry.MarketplaceSkill.Summary;
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

    /// <summary>
    /// 校验并解析"预览地址"三元组。返回 (url, source, hostedSiteId, error)。
    /// - external: 必须是 http/https，长度 ≤ 512
    /// - hosted_site: 查 HostedSite 归属当前用户，实际落的 url 以 SiteUrl 为准
    /// - 空 / null：四个字段全 null
    /// </summary>
    private async Task<(string? Url, string? Source, string? HostedSiteId, string? Error)> ResolvePreviewAsync(
        string userId,
        string? previewUrl,
        string? previewSource,
        string? previewHostedSiteId,
        CancellationToken ct)
    {
        var source = (previewSource ?? "").Trim().ToLowerInvariant();
        var urlInput = (previewUrl ?? "").Trim();
        var siteIdInput = (previewHostedSiteId ?? "").Trim();

        // 三者皆空 → 未提供
        if (string.IsNullOrEmpty(source) && string.IsNullOrEmpty(urlInput) && string.IsNullOrEmpty(siteIdInput))
            return (null, null, null, null);

        if (source == "none")
            return (null, null, null, null);

        if (source == "hosted_site")
        {
            if (string.IsNullOrEmpty(siteIdInput))
                return (null, null, null, "选择托管页面时 previewHostedSiteId 不能为空");

            var site = await _db.HostedSites
                .Find(s => s.Id == siteIdInput && s.OwnerUserId == userId)
                .FirstOrDefaultAsync(ct);
            if (site == null)
                return (null, null, null, "所选托管页面不存在或无权访问");
            if (string.IsNullOrWhiteSpace(site.SiteUrl))
                return (null, null, null, "所选托管页面尚未生成可访问 URL");

            var resolved = TrimChars(site.SiteUrl, PreviewUrlMaxLen);
            return (resolved, "hosted_site", site.Id, null);
        }

        if (source == "external" || (string.IsNullOrEmpty(source) && !string.IsNullOrEmpty(urlInput)))
        {
            if (string.IsNullOrEmpty(urlInput))
                return (null, null, null, "预览地址不能为空");
            if (urlInput.Length > PreviewUrlMaxLen)
                return (null, null, null, $"预览地址过长（不超过 {PreviewUrlMaxLen} 字符）");
            if (!Uri.TryCreate(urlInput, UriKind.Absolute, out var parsed) ||
                (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps))
                return (null, null, null, "预览地址必须是 http:// 或 https:// 开头的完整 URL");

            return (urlInput, "external", null, null);
        }

        return (null, null, null, $"未知的 previewSource: {previewSource}");
    }

    /// <summary>
    /// 规则提取 SKILL.md 摘要：按 description frontmatter → 首段 → 返回。不涉及 LLM。
    /// 提取不到时返回空串，交由上层走 LLM 兜底。
    /// </summary>
    private static string ExtractDescriptionByRule(string skillMd)
    {
        if (string.IsNullOrWhiteSpace(skillMd)) return string.Empty;

        // 1. 尝试 YAML frontmatter 的 description 字段
        var fmMatch = Regex.Match(skillMd, @"^---\s*\r?\n([\s\S]*?)\r?\n---", RegexOptions.Multiline);
        if (fmMatch.Success)
        {
            var fm = fmMatch.Groups[1].Value;
            var descMatch = Regex.Match(fm, @"^\s*description\s*:\s*[""']?([^""'\r\n]+)[""']?", RegexOptions.Multiline | RegexOptions.IgnoreCase);
            if (descMatch.Success)
            {
                var d = descMatch.Groups[1].Value.Trim();
                if (!string.IsNullOrWhiteSpace(d))
                    return TrimChars(d, SummaryMaxChars);
            }
        }

        // 2. 去掉 frontmatter，找首个非标题、非空行
        var body = Regex.Replace(skillMd, @"^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?", "");
        foreach (var rawLine in body.Split('\n'))
        {
            var line = rawLine.Trim();
            if (string.IsNullOrEmpty(line)) continue;
            if (line.StartsWith("#")) continue; // Markdown 标题跳过
            if (line.StartsWith(">")) continue; // 引用跳过
            if (line.StartsWith("```")) continue;
            // 去掉 Markdown 链接、粗体、斜体等常见干扰符
            var cleaned = Regex.Replace(line, @"\[([^\]]+)\]\([^)]+\)", "$1");
            cleaned = Regex.Replace(cleaned, @"[*_`]+", "");
            cleaned = cleaned.Trim();
            if (cleaned.Length >= 6)
                return TrimChars(cleaned, SummaryMaxChars);
        }
        return string.Empty;
    }

    private static string GuessImageMime(string ext) => ext switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        _ => "application/octet-stream"
    };

    private static List<string> ParseTags(string? tagsJson)
    {
        return TryParseTags(tagsJson, out var tags) ? tags : new List<string>();
    }

    private static bool TryParseTags(string? tagsJson, out List<string> tags)
    {
        tags = new List<string>();
        if (string.IsNullOrWhiteSpace(tagsJson))
            return true;
        try
        {
            var parsed = JsonSerializer.Deserialize<List<string>>(tagsJson);
            if (parsed == null) return true;
            tags = parsed
                .Where(t => !string.IsNullOrWhiteSpace(t))
                .Select(t => TrimChars(t.Trim(), MaxTagLength))
                .Where(t => !string.IsNullOrEmpty(t))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(MaxTagsPerItem)
                .ToList();
            return true;
        }
        catch
        {
            return false;
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

    private static string NormalizeTitle(string? title, string fallback)
    {
        var normalized = TrimChars((title ?? string.Empty).Trim(), TitleMaxChars);
        return string.IsNullOrWhiteSpace(normalized) ? fallback : normalized;
    }

    private static string NormalizeDescription(string? description, string fallback)
    {
        var normalized = TrimChars((description ?? string.Empty).Trim(), DescriptionMaxChars);
        return string.IsNullOrWhiteSpace(normalized) ? fallback : normalized;
    }

    private static string NormalizeIcon(string? iconEmoji, string fallback)
    {
        var normalized = (iconEmoji ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
            normalized = string.IsNullOrWhiteSpace(fallback) ? "🧩" : fallback;
        return normalized.Length > 4 ? normalized[..4] : normalized;
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
            previewSource = s.PreviewSource,
            previewHostedSiteId = s.PreviewHostedSiteId,
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
