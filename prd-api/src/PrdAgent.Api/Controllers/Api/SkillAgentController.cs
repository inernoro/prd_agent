using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 技能引导创建 Agent
/// 通过 5 阶段对话引导用户创建技能，支持导出 .md 和 .zip
/// </summary>
[ApiController]
[Route("api/skill-agent")]
[Authorize]
[AdminController("skill-agent", AdminPermissionCatalog.SkillAgentUse)]
public class SkillAgentController : ControllerBase
{
    private const string AppKey = "skill-agent";

    // In-memory session store (scoped to application lifetime)
    // For production scale, consider moving to Redis
    private static readonly ConcurrentDictionary<string, SkillAgentSession> Sessions = new();
    private static readonly TimeSpan SessionExpiry = TimeSpan.FromHours(2);

    private readonly SkillAgentService _service;
    private readonly ISkillService _skillService;
    private readonly MongoDbContext _db;
    private readonly ILogger<SkillAgentController> _logger;

    public SkillAgentController(
        SkillAgentService service,
        ISkillService skillService,
        MongoDbContext db,
        ILogger<SkillAgentController> logger)
    {
        _service = service;
        _skillService = skillService;
        _db = db;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();
    private string? GetUsername() => User.FindFirst("name")?.Value ?? User.FindFirst(ClaimTypes.Name)?.Value;

    /// <summary>
    /// 创建引导会话
    /// </summary>
    [HttpPost("sessions")]
    public IActionResult CreateSession()
    {
        var userId = GetUserId();
        CleanupExpiredSessions();

        var session = new SkillAgentSession
        {
            UserId = userId,
        };

        Sessions[session.Id] = session;

        _logger.LogInformation("[skill-agent] Session created: {SessionId} by {UserId}", session.Id, userId);

        var welcome = _service.GenerateWelcome();

        return Ok(ApiResponse<object>.Ok(new
        {
            sessionId = session.Id,
            currentStage = session.CurrentStage,
            stageLabel = SkillAgentService.GetStageLabel(session.CurrentStage),
            stageIndex = 0,
            stages = SkillAgentService.Stages.Select((s, i) => new
            {
                key = s,
                label = SkillAgentService.GetStageLabel(s),
                index = i,
            }),
            welcome = welcome.Data,
        }));
    }

    /// <summary>
    /// 发送消息（SSE 流式返回 AI 引导回复）
    /// </summary>
    [HttpPost("sessions/{sessionId}/messages")]
    [Produces("text/event-stream")]
    public async Task SendMessage(string sessionId, [FromBody] SkillAgentMessageRequest request)
    {
        var userId = GetUserId();

        if (!Sessions.TryGetValue(sessionId, out var session) || session.UserId != userId)
        {
            Response.StatusCode = 404;
            return;
        }

        if (string.IsNullOrWhiteSpace(request.Message))
        {
            Response.StatusCode = 400;
            return;
        }

        session.LastActiveAt = DateTime.UtcNow;

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";

        // Stage announcement
        await WriteSseEvent("stage", new
        {
            stage = session.CurrentStage,
            stageLabel = SkillAgentService.GetStageLabel(session.CurrentStage),
            stageIndex = Array.IndexOf(SkillAgentService.Stages, session.CurrentStage),
            message = $"正在{SkillAgentService.GetStageLabel(session.CurrentStage)}…"
        });

        await foreach (var chunk in _service.ProcessMessageAsync(session, request.Message, userId))
        {
            await WriteSseEvent(chunk.Event, chunk.Data);
        }
    }

    /// <summary>
    /// 获取会话状态
    /// </summary>
    [HttpGet("sessions/{sessionId}")]
    public IActionResult GetSession(string sessionId)
    {
        var userId = GetUserId();

        if (!Sessions.TryGetValue(sessionId, out var session) || session.UserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "会话不存在"));

        return Ok(ApiResponse<object>.Ok(new
        {
            sessionId = session.Id,
            currentStage = session.CurrentStage,
            stageLabel = SkillAgentService.GetStageLabel(session.CurrentStage),
            stageIndex = Array.IndexOf(SkillAgentService.Stages, session.CurrentStage),
            intent = session.Intent,
            hasSkillDraft = session.SkillDraft != null,
            skillPreview = session.SkillDraft != null ? SkillMdFormat.Serialize(session.SkillDraft) : null,
            messages = session.Messages.Select(m => new { m.Role, m.Content }),
        }));
    }

    /// <summary>
    /// 保存为个人技能
    /// </summary>
    [HttpPost("sessions/{sessionId}/save")]
    public async Task<IActionResult> SaveSkill(string sessionId)
    {
        var userId = GetUserId();

        if (!Sessions.TryGetValue(sessionId, out var session) || session.UserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "会话不存在"));

        if (session.SkillDraft == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "技能草稿尚未完成"));

        var (skill, alreadySaved) = await _service.SaveAsPersonalSkillAsync(session, userId);
        if (skill == null)
            return StatusCode(500, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "保存失败"));

        _logger.LogInformation(
            "[skill-agent] Skill {Op}: {SkillKey} by {UserId}",
            alreadySaved ? "updated" : "saved",
            skill.SkillKey, userId);

        return Ok(ApiResponse<object>.Ok(new
        {
            skillKey = skill.SkillKey,
            title = skill.Title,
            alreadySaved,
            message = alreadySaved
                ? $"技能「{skill.Title}」已更新到你的个人技能库"
                : $"技能「{skill.Title}」已保存到你的个人技能库",
        }));
    }

    /// <summary>
    /// 保存后自动试跑：生成测试输入 → 运行技能 → SSE 流式返回
    /// </summary>
    [HttpPost("sessions/{sessionId}/auto-test")]
    [Produces("text/event-stream")]
    public async Task AutoTest(string sessionId)
    {
        var userId = GetUserId();

        if (!Sessions.TryGetValue(sessionId, out var session) || session.UserId != userId)
        {
            Response.StatusCode = 404;
            return;
        }

        if (session.SkillDraft == null)
        {
            Response.StatusCode = 400;
            return;
        }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";

        await foreach (var chunk in _service.AutoTestAfterSaveAsync(session, userId))
        {
            await WriteSseEvent(chunk.Event, chunk.Data);
        }
    }

    /// <summary>
    /// 导出为 SKILL.md
    /// </summary>
    [HttpGet("sessions/{sessionId}/export/md")]
    public IActionResult ExportMarkdown(string sessionId)
    {
        var userId = GetUserId();

        if (!Sessions.TryGetValue(sessionId, out var session) || session.UserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "会话不存在"));

        var md = _service.ExportAsMarkdown(session);
        if (md == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "技能草稿尚未完成"));

        var fileName = $"{session.SkillDraft?.SkillKey ?? "skill"}.md";

        return Ok(ApiResponse<object>.Ok(new
        {
            skillMd = md,
            fileName,
        }));
    }

    /// <summary>
    /// 导出为 ZIP 包（SKILL.md + README.md + examples/）
    /// </summary>
    [HttpGet("sessions/{sessionId}/export/zip")]
    public async Task<IActionResult> ExportZip(string sessionId)
    {
        var userId = GetUserId();

        if (!Sessions.TryGetValue(sessionId, out var session) || session.UserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "会话不存在"));

        var zipBytes = await _service.ExportAsZipAsync(session, userId);
        if (zipBytes == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "技能草稿尚未完成"));

        var fileName = $"{session.SkillDraft?.SkillKey ?? "skill"}.zip";

        return File(zipBytes, "application/zip", fileName);
    }

    /// <summary>
    /// 删除会话
    /// </summary>
    [HttpDelete("sessions/{sessionId}")]
    public IActionResult DeleteSession(string sessionId)
    {
        var userId = GetUserId();

        if (Sessions.TryGetValue(sessionId, out var session) && session.UserId == userId)
        {
            Sessions.TryRemove(sessionId, out _);
        }

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 试用技能：输入测试内容，LLM 用技能的 prompt template 生成结果（SSE 流式）
    /// </summary>
    [HttpPost("test/{skillKey}")]
    [Produces("text/event-stream")]
    public async Task TestSkill(string skillKey, [FromBody] SkillTestRequest request)
    {
        var userId = GetUserId();

        var skill = await _service.GetSkillForTestAsync(skillKey, userId);
        if (skill == null)
        {
            Response.StatusCode = 404;
            return;
        }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";

        await foreach (var chunk in _service.TestSkillAsync(skill, request.UserInput ?? "", userId))
        {
            await WriteSseEvent(chunk.Event, chunk.Data);
        }
    }

    // ━━━ Skill Detail CRUD ━━━━━━━━

    /// <summary>
    /// 获取技能的 SKILL.md 内容（用于编辑器展示）
    /// </summary>
    [HttpGet("skills/{skillKey}/md")]
    public async Task<IActionResult> GetSkillMd(string skillKey, CancellationToken ct)
    {
        var userId = GetUserId();
        var skill = await _skillService.GetByKeyAsync(skillKey, ct);
        if (skill == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "技能不存在"));
        if (skill.Visibility == SkillVisibility.Personal && skill.OwnerUserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权访问"));

        var md = SkillMdFormat.Serialize(skill);
        return Ok(ApiResponse<object>.Ok(new { skillMd = md, skillKey = skill.SkillKey }));
    }

    /// <summary>
    /// 通过 SKILL.md 文本更新技能（编辑器保存）
    /// </summary>
    [HttpPut("skills/{skillKey}/md")]
    public async Task<IActionResult> UpdateSkillFromMd(string skillKey, [FromBody] UpdateSkillMdRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(request.SkillMd))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "内容不能为空"));

        var parsed = SkillMdFormat.Deserialize(request.SkillMd);
        if (parsed == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "SKILL.md 格式解析失败"));

        var updated = await _skillService.UpdatePersonalSkillAsync(userId, skillKey, parsed, ct);
        if (!updated)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "技能不存在或无权修改"));

        _logger.LogInformation("[skill-agent] Skill updated from md: {SkillKey} by {UserId}", skillKey, userId);
        return Ok(ApiResponse<object>.Ok(new { skillKey, title = parsed.Title }));
    }

    // ━━━ 技能广场 ━━━━━━━━

    /// <summary>
    /// 发布技能到广场
    /// </summary>
    [HttpPost("skills/{skillKey}/publish")]
    public async Task<IActionResult> PublishSkill(string skillKey, CancellationToken ct)
    {
        var userId = GetUserId();
        var skill = await _skillService.GetByKeyAsync(skillKey, ct);
        if (skill == null || skill.OwnerUserId != userId || skill.Visibility != SkillVisibility.Personal)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "技能不存在或无权操作"));

        // Get author info
        var user = await _db.Users.Find(u => u.Id == userId).FirstOrDefaultAsync(ct);
        var authorName = GetUsername() ?? user?.DisplayName ?? "匿名用户";
        var authorAvatar = user?.AvatarFileName;

        var update = Builders<Skill>.Update
            .Set(s => s.IsPublic, true)
            .Set(s => s.AuthorName, authorName)
            .Set(s => s.AuthorAvatar, authorAvatar)
            .Set(s => s.PublishedAt, DateTime.UtcNow)
            .Set(s => s.UpdatedAt, DateTime.UtcNow);

        await _db.Skills.UpdateOneAsync(
            s => s.SkillKey == skillKey && s.OwnerUserId == userId,
            update, cancellationToken: ct);

        _logger.LogInformation("[skill-agent] Skill published: {SkillKey} by {UserId}", skillKey, userId);
        return Ok(ApiResponse<object>.Ok(new { skillKey, published = true }));
    }

    /// <summary>
    /// 从广场取消发布
    /// </summary>
    [HttpPost("skills/{skillKey}/unpublish")]
    public async Task<IActionResult> UnpublishSkill(string skillKey, CancellationToken ct)
    {
        var userId = GetUserId();

        var update = Builders<Skill>.Update
            .Set(s => s.IsPublic, false)
            .Set(s => s.PublishedAt, (DateTime?)null)
            .Set(s => s.UpdatedAt, DateTime.UtcNow);

        var result = await _db.Skills.UpdateOneAsync(
            s => s.SkillKey == skillKey && s.OwnerUserId == userId,
            update, cancellationToken: ct);

        if (result.ModifiedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "技能不存在或无权操作"));

        _logger.LogInformation("[skill-agent] Skill unpublished: {SkillKey} by {UserId}", skillKey, userId);
        return Ok(ApiResponse<object>.Ok(new { skillKey, published = false }));
    }

    /// <summary>
    /// 技能广场列表（所有已发布的技能）
    /// </summary>
    [HttpGet("plaza")]
    public async Task<IActionResult> Plaza(
        [FromQuery] string? category,
        [FromQuery] string? search,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        pageSize = Math.Clamp(pageSize, 1, 50);
        page = Math.Max(1, page);

        var filter = Builders<Skill>.Filter.Eq(s => s.IsPublic, true)
                   & Builders<Skill>.Filter.Eq(s => s.IsEnabled, true);

        if (!string.IsNullOrWhiteSpace(category) && category != "all")
            filter &= Builders<Skill>.Filter.Eq(s => s.Category, category);

        if (!string.IsNullOrWhiteSpace(search))
        {
            var searchFilter = Builders<Skill>.Filter.Or(
                Builders<Skill>.Filter.Regex(s => s.Title, new MongoDB.Bson.BsonRegularExpression(search, "i")),
                Builders<Skill>.Filter.Regex(s => s.Description, new MongoDB.Bson.BsonRegularExpression(search, "i")),
                Builders<Skill>.Filter.AnyIn(s => s.Tags, new[] { search })
            );
            filter &= searchFilter;
        }

        var total = await _db.Skills.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.Skills.Find(filter)
            .SortByDescending(s => s.UsageCount)
            .ThenByDescending(s => s.PublishedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        // Return without execution config (security)
        var result = items.Select(s => new
        {
            s.SkillKey, s.Title, s.Description, s.Icon, s.Category, s.Tags,
            s.UsageCount, s.AuthorName, s.AuthorAvatar, s.PublishedAt,
            s.IsPublic, s.OwnerUserId,
        });

        return Ok(ApiResponse<object>.Ok(new { items = result, total, page, pageSize }));
    }

    // ━━━ Helpers ━━━━━━━━

    private async Task WriteSseEvent(string eventName, object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });
            await Response.WriteAsync($"event: {eventName}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
    }

    private static void CleanupExpiredSessions()
    {
        var cutoff = DateTime.UtcNow - SessionExpiry;
        var expired = Sessions.Where(kv => kv.Value.LastActiveAt < cutoff).Select(kv => kv.Key).ToList();
        foreach (var key in expired)
        {
            Sessions.TryRemove(key, out _);
        }
    }
}

// ━━━ Request DTOs ━━━━━━━━

public class SkillAgentMessageRequest
{
    public string Message { get; set; } = string.Empty;
}

public class SkillTestRequest
{
    public string? UserInput { get; set; }
}

public class UpdateSkillMdRequest
{
    public string SkillMd { get; set; } = string.Empty;
}
