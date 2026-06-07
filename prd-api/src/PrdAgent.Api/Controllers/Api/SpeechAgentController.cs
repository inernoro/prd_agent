using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.SpeechAgent;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 演讲智能体 — 长文本转思维导图演讲。
/// 首期模式：mindmap。后续可加 outline / story / data 多模式（同一 deck/node 结构）。
/// </summary>
[ApiController]
[Route("api/speech-agent")]
[Authorize]
[AdminController("speech-agent", AdminPermissionCatalog.SpeechAgentUse)]
public class SpeechAgentController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly SpeechAgentService _service;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IHostedSiteService _hostedSites;
    private readonly ITeamService _teams;
    private readonly IDocumentService _documentService;
    private readonly ILogger<SpeechAgentController> _logger;

    private static readonly JsonSerializerOptions SseJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public SpeechAgentController(
        MongoDbContext db,
        SpeechAgentService service,
        ILLMRequestContextAccessor llmRequestContext,
        IHostedSiteService hostedSites,
        ITeamService teams,
        IDocumentService documentService,
        ILogger<SpeechAgentController> logger)
    {
        _db = db;
        _service = service;
        _llmRequestContext = llmRequestContext;
        _hostedSites = hostedSites;
        _teams = teams;
        _documentService = documentService;
        _logger = logger;
    }

    // ── CRUD ─────────────────────────────────────────

    [HttpGet("decks")]
    public async Task<IActionResult> ListDecks([FromQuery] int page = 1, [FromQuery] int pageSize = 20)
    {
        var userId = this.GetRequiredUserId();
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var filter = Builders<SpeechDeck>.Filter.Eq(d => d.OwnerUserId, userId);
        var total = await _db.SpeechDecks.CountDocumentsAsync(filter);
        // 列表只渲染卡片元数据,不返回 SourceText(可达 1MB+)避免每页几十 MB 传输
        // (Codex P2 "Exclude source text from deck lists")
        var items = await _db.SpeechDecks.Find(filter)
            .SortByDescending(d => d.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .Project(d => new
            {
                d.Id,
                d.OwnerUserId,
                d.Title,
                d.Mode,
                d.SourceType,
                d.SourceRefId,
                d.Audience,
                d.Style,
                d.Depth,
                d.Theme,
                d.Status,
                d.ErrorMessage,
                d.CoverImageAssetId,
                d.Model,
                d.Platform,
                d.NodeCount,
                d.PublishedSiteId,
                d.PublishedShareToken,
                d.PublishedAt,
                d.IllustrationStyle,
                d.CreatedAt,
                d.UpdatedAt,
            })
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    public class CreateDeckRequest
    {
        public string? Title { get; set; }
        public string SourceType { get; set; } = SpeechDeckSourceType.Paste;
        public string? SourceRefId { get; set; }
        public string SourceText { get; set; } = string.Empty;
        public string? Audience { get; set; }
        public string? Style { get; set; }
        public int? Depth { get; set; }
    }

    [HttpPost("decks")]
    public async Task<IActionResult> CreateDeck([FromBody] CreateDeckRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.SourceText) || req.SourceText.Trim().Length < 30)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "原始材料过短（至少 30 字）"));

        var userId = this.GetRequiredUserId();
        var src = req.SourceText.Trim();
        // 截断到与 LLM 实际使用相同的上限,避免 DB 存 1MB 但模型只看 16K 的认知错位
        // (Bugbot Medium "Source text not truncated")
        if (src.Length > SpeechAgentService.SourceTextMaxChars)
            src = src[..SpeechAgentService.SourceTextMaxChars];
        var deck = new SpeechDeck
        {
            OwnerUserId = userId,
            Title = string.IsNullOrWhiteSpace(req.Title) ? src[..Math.Min(40, src.Length)] : req.Title.Trim(),
            Mode = SpeechDeckMode.Mindmap,
            SourceType = req.SourceType ?? SpeechDeckSourceType.Paste,
            SourceRefId = req.SourceRefId,
            SourceText = src,
            Audience = string.IsNullOrWhiteSpace(req.Audience) ? "通识" : req.Audience.Trim(),
            Style = string.IsNullOrWhiteSpace(req.Style) ? "专业" : req.Style.Trim(),
            Depth = Math.Clamp(req.Depth ?? 3, 2, 4),
            Status = SpeechDeckStatus.Draft,
        };
        await _db.SpeechDecks.InsertOneAsync(deck);

        _logger.LogInformation("[speech] Deck created: {DeckId} by {UserId}", deck.Id, userId);
        return Ok(ApiResponse<object>.Ok(new { deck }));
    }

    [HttpGet("decks/{deckId}")]
    public async Task<IActionResult> GetDeck(string deckId)
    {
        var userId = this.GetRequiredUserId();
        var deck = await _db.SpeechDecks.Find(d => d.Id == deckId && d.OwnerUserId == userId).FirstOrDefaultAsync();
        if (deck == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "演讲不存在"));
        var nodes = await _db.SpeechNodes.Find(n => n.DeckId == deckId)
            .SortBy(n => n.Depth).ThenBy(n => n.Order)
            .ToListAsync();

        // 关联读节点配图 URL（不让前端二次查询）
        var assetIds = nodes.Where(n => !string.IsNullOrEmpty(n.ImageAssetId)).Select(n => n.ImageAssetId!).Distinct().ToList();
        var urlByAssetId = assetIds.Count > 0
            ? (await _db.ImageAssets.Find(a => assetIds.Contains(a.Id)).ToListAsync()).ToDictionary(a => a.Id, a => a.Url)
            : new Dictionary<string, string>();

        var enriched = nodes.Select(n => new
        {
            n.Id, n.DeckId, n.ParentId, n.Order, n.Depth, n.Title, n.BulletPoints,
            n.SpeakerNotes, n.ImageAssetId, n.Status, n.CreatedAt, n.UpdatedAt,
            ImageUrl = !string.IsNullOrEmpty(n.ImageAssetId) && urlByAssetId.TryGetValue(n.ImageAssetId, out var u) ? u : null,
        });
        return Ok(ApiResponse<object>.Ok(new { deck, nodes = enriched }));
    }

    [HttpDelete("decks/{deckId}")]
    public async Task<IActionResult> DeleteDeck(string deckId)
    {
        var userId = this.GetRequiredUserId();
        var result = await _db.SpeechDecks.DeleteOneAsync(d => d.Id == deckId && d.OwnerUserId == userId);
        if (result.DeletedCount == 0) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "演讲不存在"));
        await _db.SpeechNodes.DeleteManyAsync(n => n.DeckId == deckId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    public class UpdateDeckRequest
    {
        public string? Title { get; set; }
        public string? Audience { get; set; }
        public string? Style { get; set; }
        public int? Depth { get; set; }
        public string? Theme { get; set; }
        public string? IllustrationStyle { get; set; }
    }

    [HttpPatch("decks/{deckId}")]
    public async Task<IActionResult> UpdateDeck(string deckId, [FromBody] UpdateDeckRequest req)
    {
        var userId = this.GetRequiredUserId();
        var deck = await _db.SpeechDecks.Find(d => d.Id == deckId && d.OwnerUserId == userId).FirstOrDefaultAsync();
        if (deck == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "演讲不存在"));

        var update = Builders<SpeechDeck>.Update.Set(d => d.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(req.Title)) update = update.Set(d => d.Title, req.Title.Trim());
        if (!string.IsNullOrWhiteSpace(req.Audience)) update = update.Set(d => d.Audience, req.Audience.Trim());
        if (!string.IsNullOrWhiteSpace(req.Style)) update = update.Set(d => d.Style, req.Style.Trim());
        if (req.Depth.HasValue) update = update.Set(d => d.Depth, Math.Clamp(req.Depth.Value, 2, 4));
        if (!string.IsNullOrWhiteSpace(req.Theme)) update = update.Set(d => d.Theme, req.Theme.Trim());
        if (!string.IsNullOrWhiteSpace(req.IllustrationStyle)) update = update.Set(d => d.IllustrationStyle, req.IllustrationStyle.Trim());
        await _db.SpeechDecks.UpdateOneAsync(d => d.Id == deckId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    // ── E1 节点配图 ───────────────────────────────

    [HttpPost("decks/{deckId}/nodes/{nodeId}/generate-image")]
    public async Task<IActionResult> GenerateNodeImage(string deckId, string nodeId)
    {
        var userId = this.GetRequiredUserId();
        var deck = await _db.SpeechDecks.Find(d => d.Id == deckId && d.OwnerUserId == userId).FirstOrDefaultAsync();
        if (deck == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "演讲不存在"));
        var node = await _db.SpeechNodes.Find(n => n.Id == nodeId && n.DeckId == deckId).FirstOrDefaultAsync();
        if (node == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "节点不存在"));

        using var llmCtx = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null, SessionId: null, UserId: userId, ViewRole: null,
            DocumentChars: null, DocumentHash: null,
            SystemPromptRedacted: "[SPEECH_NODE_IMAGE]",
            RequestType: "imageGen",
            AppCallerCode: AppCallerRegistry.SpeechAgent.Mindmap.NodeImage));

        var assetId = await _service.GenerateNodeImageAsync(deck, node);
        if (assetId == null) return StatusCode(502, ApiResponse<object>.Fail("IMAGE_GEN_FAILED", "配图生成失败"));

        var asset = await _db.ImageAssets.Find(a => a.Id == assetId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { imageAssetId = assetId, url = asset?.Url }));
    }

    // ── E3 演讲备注 ───────────────────────────────

    [HttpPost("decks/{deckId}/nodes/{nodeId}/generate-notes")]
    public async Task<IActionResult> GenerateNodeNotes(string deckId, string nodeId)
    {
        var userId = this.GetRequiredUserId();
        var deck = await _db.SpeechDecks.Find(d => d.Id == deckId && d.OwnerUserId == userId).FirstOrDefaultAsync();
        if (deck == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "演讲不存在"));
        var node = await _db.SpeechNodes.Find(n => n.Id == nodeId && n.DeckId == deckId).FirstOrDefaultAsync();
        if (node == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "节点不存在"));

        using var llmCtx = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null, SessionId: null, UserId: userId, ViewRole: null,
            DocumentChars: null, DocumentHash: null,
            SystemPromptRedacted: "[SPEECH_NOTES]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.SpeechAgent.Mindmap.SpeakerNotes));

        var notes = await _service.GenerateSpeakerNotesAsync(node, deck.Title);
        if (notes == null) return StatusCode(502, ApiResponse<object>.Fail("NOTES_GEN_FAILED", "备注生成失败"));
        return Ok(ApiResponse<object>.Ok(new { speakerNotes = notes }));
    }

    [HttpPost("decks/{deckId}/generate-notes-batch")]
    public async Task<IActionResult> GenerateNotesBatch(string deckId)
    {
        var userId = this.GetRequiredUserId();
        var deck = await _db.SpeechDecks.Find(d => d.Id == deckId && d.OwnerUserId == userId).FirstOrDefaultAsync();
        if (deck == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "演讲不存在"));
        var nodes = await _db.SpeechNodes.Find(n => n.DeckId == deckId).ToListAsync();

        using var llmCtx = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null, SessionId: null, UserId: userId, ViewRole: null,
            DocumentChars: null, DocumentHash: null,
            SystemPromptRedacted: "[SPEECH_NOTES_BATCH]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.SpeechAgent.Mindmap.SpeakerNotes));

        int ok = 0;
        foreach (var n in nodes)
        {
            if (!string.IsNullOrWhiteSpace(n.SpeakerNotes)) continue;
            var notes = await _service.GenerateSpeakerNotesAsync(n, deck.Title);
            if (notes != null) ok++;
        }
        return Ok(ApiResponse<object>.Ok(new { generated = ok, total = nodes.Count }));
    }

    // ── E10/E11 节点 AI 重写 ──────────────────────

    public class RewriteNodeRequest { public string? Style { get; set; } }

    [HttpPost("decks/{deckId}/nodes/{nodeId}/rewrite")]
    public async Task<IActionResult> RewriteNode(string deckId, string nodeId, [FromBody] RewriteNodeRequest req)
    {
        var userId = this.GetRequiredUserId();
        var deck = await _db.SpeechDecks.Find(d => d.Id == deckId && d.OwnerUserId == userId).FirstOrDefaultAsync();
        if (deck == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "演讲不存在"));
        var node = await _db.SpeechNodes.Find(n => n.Id == nodeId && n.DeckId == deckId).FirstOrDefaultAsync();
        if (node == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "节点不存在"));

        using var llmCtx = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null, SessionId: null, UserId: userId, ViewRole: null,
            DocumentChars: null, DocumentHash: null,
            SystemPromptRedacted: "[SPEECH_NODE_REWRITE]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.SpeechAgent.Mindmap.NodeRewrite));

        var result = await _service.RewriteNodeAsync(node, req.Style ?? "concise", deck.Title);
        if (result == null) return StatusCode(502, ApiResponse<object>.Fail("REWRITE_FAILED", "重写失败"));
        await _db.SpeechNodes.UpdateOneAsync(
            n => n.Id == nodeId,
            Builders<SpeechNode>.Update
                .Set(n => n.Title, result.Value.title)
                .Set(n => n.BulletPoints, result.Value.bullets)
                .Set(n => n.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { title = result.Value.title, bulletPoints = result.Value.bullets }));
    }

    // ── E2 一键发布 HTML 演讲站 ───────────────────

    [HttpPost("decks/{deckId}/publish")]
    public async Task<IActionResult> Publish(string deckId)
    {
        var userId = this.GetRequiredUserId();
        var deck = await _db.SpeechDecks.Find(d => d.Id == deckId && d.OwnerUserId == userId).FirstOrDefaultAsync();
        if (deck == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "演讲不存在"));
        var nodes = await _db.SpeechNodes.Find(n => n.DeckId == deckId).ToListAsync();
        if (nodes.Count == 0) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "演讲没有节点"));

        // 拉每个节点的配图 URL
        var assetIds = nodes.Where(n => !string.IsNullOrEmpty(n.ImageAssetId)).Select(n => n.ImageAssetId!).ToList();
        var assets = assetIds.Count > 0
            ? await _db.ImageAssets.Find(a => assetIds.Contains(a.Id)).ToListAsync()
            : new List<ImageAsset>();
        var urlByAssetId = assets.ToDictionary(a => a.Id, a => (string?)a.Url);
        var urlByNodeId = nodes.ToDictionary(
            n => n.Id,
            n => !string.IsNullOrEmpty(n.ImageAssetId) && urlByAssetId.TryGetValue(n.ImageAssetId!, out var u) ? u : null);

        var html = _service.RenderDeckHtml(deck, nodes, urlByNodeId);

        // 复用 IHostedSiteService.CreateFromContentAsync(已有 COS 上传逻辑)
        var site = await _hostedSites.CreateFromContentAsync(
            userId, html,
            title: deck.Title,
            description: $"演讲 · {deck.Audience} · {deck.Style}",
            sourceType: "speech-agent",
            sourceRef: deckId,
            tags: null, folder: null);

        // 创建 public 分享链（owner 可重新发布会覆盖）
        var share = new WebPageShareLink
        {
            CreatedBy = userId,
            SiteId = site.Id,
            ShareType = "single",
            Purpose = "share",
            Title = deck.Title,
            AccessLevel = "public",
        };
        await _db.WebPageShareLinks.InsertOneAsync(share);

        await _db.SpeechDecks.UpdateOneAsync(
            d => d.Id == deckId,
            Builders<SpeechDeck>.Update
                .Set(d => d.PublishedSiteId, site.Id)
                .Set(d => d.PublishedShareToken, share.Token)
                .Set(d => d.PublishedAt, DateTime.UtcNow)
                .Set(d => d.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new
        {
            siteId = site.Id,
            shareToken = share.Token,
            shareUrl = $"/s/wp/{share.Token}",
        }));
    }

    // ── E7 从知识库选文档作为输入 ──────────────────

    public class CreateFromDocumentRequest
    {
        public string EntryId { get; set; } = string.Empty;
        public string? Title { get; set; }
        public string? Audience { get; set; }
        public string? Style { get; set; }
        public int? Depth { get; set; }
        public string? IllustrationStyle { get; set; }
    }

    [HttpPost("decks/from-document")]
    public async Task<IActionResult> CreateFromDocument([FromBody] CreateFromDocumentRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.EntryId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少 entryId"));
        var userId = this.GetRequiredUserId();

        // 与 DocumentStoreController.CanReadStoreAsync 全口径对齐：
        //   owner / public / team-shared / pm-project member / product-knowledge member 五类都放行
        //   (Bugbot Medium "From-document auth too narrow" + Codex P2 "Preserve document-store read rules")
        var entry = await _db.DocumentEntries.Find(e => e.Id == req.EntryId).FirstOrDefaultAsync();
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档不存在"));
        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync();
        if (store == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));
        if (!await CanReadDocumentStoreAsync(store, userId))
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限读该文档"));

        // 同 DocumentStoreController 的内容提取链：优先 ParsedPrd.RawContent，兜底 Attachment.ExtractedText
        // 走 IDocumentService 而非直查 Mongo,保证与缓存/钩子链一致 (Bugbot Medium "KB create skips document service")
        string? src = null;
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var doc = await _documentService.GetByIdAsync(entry.DocumentId);
            if (doc != null) src = doc.RawContent;
        }
        if (string.IsNullOrEmpty(src) && !string.IsNullOrEmpty(entry.AttachmentId))
        {
            var att = await _db.Attachments.Find(a => a.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync();
            if (att != null) src = att.ExtractedText;
        }
        src = (src ?? "").Trim();
        if (src.Length < 30)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文档内容过短（不足 30 字）"));
        // 截断到 LLM 实际使用的上限 (Bugbot Medium "Source text not truncated")
        if (src.Length > SpeechAgentService.SourceTextMaxChars)
            src = src[..SpeechAgentService.SourceTextMaxChars];

        // 用户自填标题优先,空时回落到 entry.Title (Bugbot Medium "KB flow ignores custom title")
        var title = string.IsNullOrWhiteSpace(req.Title) ? entry.Title.Trim() : req.Title.Trim();

        var deck = new SpeechDeck
        {
            OwnerUserId = userId,
            Title = title,
            Mode = SpeechDeckMode.Mindmap,
            SourceType = SpeechDeckSourceType.Document,
            SourceRefId = entry.Id,
            SourceText = src,
            Audience = string.IsNullOrWhiteSpace(req.Audience) ? "通识" : req.Audience.Trim(),
            Style = string.IsNullOrWhiteSpace(req.Style) ? "专业" : req.Style.Trim(),
            Depth = Math.Clamp(req.Depth ?? 3, 2, 4),
            IllustrationStyle = string.IsNullOrWhiteSpace(req.IllustrationStyle) ? "flat" : req.IllustrationStyle.Trim(),
            Status = SpeechDeckStatus.Draft,
        };
        await _db.SpeechDecks.InsertOneAsync(deck);
        return Ok(ApiResponse<object>.Ok(new { deck }));
    }

    public class UpdateNodeRequest
    {
        public string? Title { get; set; }
        public List<string>? BulletPoints { get; set; }
        public string? SpeakerNotes { get; set; }
    }

    [HttpPatch("decks/{deckId}/nodes/{nodeId}")]
    public async Task<IActionResult> UpdateNode(string deckId, string nodeId, [FromBody] UpdateNodeRequest req)
    {
        var userId = this.GetRequiredUserId();
        var deck = await _db.SpeechDecks.Find(d => d.Id == deckId && d.OwnerUserId == userId).FirstOrDefaultAsync();
        if (deck == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "演讲不存在"));

        var update = Builders<SpeechNode>.Update.Set(n => n.UpdatedAt, DateTime.UtcNow);
        if (req.Title != null) update = update.Set(n => n.Title, req.Title.Trim());
        if (req.BulletPoints != null) update = update.Set(n => n.BulletPoints, req.BulletPoints);
        if (req.SpeakerNotes != null) update = update.Set(n => n.SpeakerNotes, req.SpeakerNotes);
        var result = await _db.SpeechNodes.UpdateOneAsync(n => n.Id == nodeId && n.DeckId == deckId, update);
        if (result.MatchedCount == 0) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "节点不存在"));
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    // ── 生成（SSE 流式） ─────────────────────────────

    /// <summary>
    /// 触发思维导图生成。SSE 流式推送 model / thinking / typing / node / done / error 事件。
    /// 客户端断开不取消任务（server-authority），但若希望支持断线续传，Phase 2 改走 Run/Worker。
    /// </summary>
    [HttpPost("decks/{deckId}/generate")]
    public async Task GenerateMindmap(string deckId, CancellationToken cancellationToken)
    {
        var userId = this.GetRequiredUserId();

        Response.Headers["Content-Type"] = "text/event-stream";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";

        var deck = await _db.SpeechDecks.Find(d => d.Id == deckId && d.OwnerUserId == userId).FirstOrDefaultAsync(CancellationToken.None);
        if (deck == null)
        {
            await WriteSseAsync("error", new { message = "演讲不存在" });
            return;
        }

        // 并发互斥：CAS deck.Status → generating。第二个并发请求被拒，防止两个 LLM 任务交错写库。
        // 同时容忍 stale generating（前一次 SSE 进程崩了没写终态）：UpdatedAt 早于 staleCutoff
        // 也可被新请求重新认领，避免死锁 deck 直到 DB 手工干预（Bugbot High）。
        var staleCutoff = DateTime.UtcNow.AddMinutes(-5);
        var claimFilter = Builders<SpeechDeck>.Filter.And(
            Builders<SpeechDeck>.Filter.Eq(d => d.Id, deckId),
            Builders<SpeechDeck>.Filter.Or(
                Builders<SpeechDeck>.Filter.Ne(d => d.Status, SpeechDeckStatus.Generating),
                Builders<SpeechDeck>.Filter.Lt(d => d.UpdatedAt, staleCutoff)));
        var claimResult = await _db.SpeechDecks.UpdateOneAsync(
            claimFilter,
            Builders<SpeechDeck>.Update
                .Set(d => d.Status, SpeechDeckStatus.Generating)
                .Set(d => d.ErrorMessage, null)
                .Set(d => d.NodeCount, 0)
                .Set(d => d.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        if (claimResult.MatchedCount == 0)
        {
            await WriteSseAsync("error", new { message = "已有一个生成任务在进行中（5 分钟内）；如确认上一次任务已死，请等满 5 分钟自动失效后重试", concurrencyRejected = true });
            return;
        }

        // 旧节点不在 claim 时删除,改到 service 内"解析成功后才删 + 插入"
        // (Bugbot/Codex P2 "Defer deleting old nodes until regeneration succeeds")
        await WriteSseAsync("phase", new { phase = "preparing", message = "准备中..." });

        using var llmCtx = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: deck.SourceText.Length,
            DocumentHash: null,
            SystemPromptRedacted: "[SPEECH_AGENT_MINDMAP]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.SpeechAgent.Mindmap.Outline));

        var startedAt = DateTime.UtcNow;
        var sentPhaseAnalyzing = false;
        var nodeCount = 0;
        string? errorMessage = null;

        try
        {
            await foreach (var ev in _service.GenerateMindmapAsync(
                deck,
                onTyping: async text =>
                {
                    if (!sentPhaseAnalyzing)
                    {
                        sentPhaseAnalyzing = true;
                        await WriteSseAsync("phase", new { phase = "analyzing", message = "AI 正在拆解大纲..." });
                    }
                    await WriteSseAsync("typing", new { text });
                },
                onThinking: async text =>
                {
                    await WriteSseAsync("thinking", new { text });
                },
                onModel: async (model, platform) =>
                {
                    // 落库与 SSE 写入串行,避免 model 事件与紧随其后的 thinking/text 写入交错 (Codex P2)
                    await _db.SpeechDecks.UpdateOneAsync(
                        d => d.Id == deckId,
                        Builders<SpeechDeck>.Update.Set(d => d.Model, model).Set(d => d.Platform, platform));
                    await WriteSseAsync("model", new { model, platform });
                }))
            {
                if (ev.Kind == "node" && ev.Node != null)
                {
                    nodeCount++;
                    await WriteSseAsync("node", new { node = ev.Node });
                }
                else if (ev.Kind == "done")
                {
                    await WriteSseAsync("done", new
                    {
                        nodeCount = ev.Count ?? nodeCount,
                        elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds,
                    });
                }
                else if (ev.Kind == "error")
                {
                    errorMessage = ev.Message;
                    await WriteSseAsync("error", new { message = ev.Message });
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[speech] Generate failed: deckId={DeckId}", deckId);
            errorMessage = ex.Message;
            try { await WriteSseAsync("error", new { message = "生成失败：" + ex.Message }); } catch { }
        }

        if (errorMessage != null)
        {
            await _db.SpeechDecks.UpdateOneAsync(
                d => d.Id == deckId,
                Builders<SpeechDeck>.Update
                    .Set(d => d.Status, SpeechDeckStatus.Failed)
                    .Set(d => d.ErrorMessage, errorMessage)
                    .Set(d => d.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
        }
    }

    private async Task WriteSseAsync(string eventType, object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, SseJson);
            await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
        // 客户端中途断开:写入失败抛 IOException 及其派生类 (ConnectionResetException 等)。
        // 与 ObjectDisposedException 同语义吞掉,服务端任务继续走完。
        // CS0160:ConnectionResetException 继承自 IOException,只 catch 父类即可。
        catch (System.IO.IOException) { }
    }

    /// <summary>
    /// 与 DocumentStoreController.CanReadStoreAsync 完全对齐的读权限判定（同口径,五类都放行）。
    /// owner / public / team-shared / pm-project member (含 observer/stakeholder) / product-knowledge member
    /// </summary>
    private async Task<bool> CanReadDocumentStoreAsync(DocumentStore s, string userId)
    {
        if (s.OwnerId == userId || s.IsPublic) return true;
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
        if (s.SharedTeamIds != null && s.SharedTeamIds.Any(myTeamIds.Contains)) return true;
        // PM Project 成员判定
        if (!string.IsNullOrEmpty(s.PmProjectId))
        {
            var p = await _db.PmProjects.Find(x => x.Id == s.PmProjectId && !x.IsDeleted).FirstOrDefaultAsync();
            if (p != null)
            {
                if (p.OwnerId == userId || p.LeaderId == userId || p.MemberIds.Contains(userId)) return true;
                if (p.ObserverIds.Contains(userId)) return true;
                if (p.Stakeholders?.Any(st => st.UserId == userId) ?? false) return true;
            }
        }
        // Product Knowledge 成员判定（store.ProductKnowledgeRef 格式 product:{id} / version:{id}）
        if (!string.IsNullOrEmpty(s.ProductKnowledgeRef))
        {
            var parts = s.ProductKnowledgeRef.Split(':', 2);
            if (parts.Length == 2)
            {
                string? productId = parts[0] switch
                {
                    "product" => parts[1],
                    "version" => (await _db.ProductVersions.Find(x => x.Id == parts[1] && !x.IsDeleted).FirstOrDefaultAsync())?.ProductId,
                    _ => null,
                };
                if (!string.IsNullOrEmpty(productId))
                {
                    var prod = await _db.Products.Find(x => x.Id == productId && !x.IsDeleted).FirstOrDefaultAsync();
                    if (prod != null && (prod.OwnerId == userId || prod.MemberIds.Contains(userId))) return true;
                }
            }
        }
        return false;
    }
}
