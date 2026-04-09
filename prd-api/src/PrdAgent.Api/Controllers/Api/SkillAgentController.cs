using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
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
    private readonly ILogger<SkillAgentController> _logger;

    public SkillAgentController(
        SkillAgentService service,
        ILogger<SkillAgentController> logger)
    {
        _service = service;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

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

        var skill = await _service.SaveAsPersonalSkillAsync(session, userId);
        if (skill == null)
            return StatusCode(500, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "保存失败"));

        _logger.LogInformation("[skill-agent] Skill saved: {SkillKey} by {UserId}", skill.SkillKey, userId);

        return Ok(ApiResponse<object>.Ok(new
        {
            skillKey = skill.SkillKey,
            title = skill.Title,
            message = $"技能「{skill.Title}」已保存到你的个人技能库",
        }));
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
