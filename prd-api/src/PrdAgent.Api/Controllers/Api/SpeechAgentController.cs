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
    private readonly ILogger<SpeechAgentController> _logger;

    private static readonly JsonSerializerOptions SseJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public SpeechAgentController(
        MongoDbContext db,
        SpeechAgentService service,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<SpeechAgentController> logger)
    {
        _db = db;
        _service = service;
        _llmRequestContext = llmRequestContext;
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
        var items = await _db.SpeechDecks.Find(filter)
            .SortByDescending(d => d.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
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
        return Ok(ApiResponse<object>.Ok(new { deck, nodes }));
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
        await _db.SpeechDecks.UpdateOneAsync(d => d.Id == deckId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
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

        await _db.SpeechNodes.DeleteManyAsync(n => n.DeckId == deckId, CancellationToken.None);
        await _db.SpeechDecks.UpdateOneAsync(
            d => d.Id == deckId,
            Builders<SpeechDeck>.Update
                .Set(d => d.Status, SpeechDeckStatus.Generating)
                .Set(d => d.ErrorMessage, null)
                .Set(d => d.NodeCount, 0)
                .Set(d => d.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        await WriteSseAsync("phase", new { phase = "preparing", message = "准备中..." });

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
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
                onModel: (model, platform) =>
                {
                    _db.SpeechDecks.UpdateOne(
                        d => d.Id == deckId,
                        Builders<SpeechDeck>.Update.Set(d => d.Model, model).Set(d => d.Platform, platform));
                    _ = WriteSseAsync("model", new { model, platform });
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
    }
}
