using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - LLM 请求日志
/// </summary>
[ApiController]
[Route("api/v1/admin/llm-logs")]
[Authorize(Roles = "ADMIN")]
public class AdminLlmLogsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public AdminLlmLogsController(MongoDbContext db)
    {
        _db = db;
    }

    [HttpGet("meta")]
    public async Task<IActionResult> Meta()
    {
        // 下拉枚举：为了稳定性，status 使用固定枚举；provider/model 使用 distinct
        var providers = (await _db.LlmRequestLogs
                .Distinct(x => x.Provider, Builders<LlmRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var models = (await _db.LlmRequestLogs
                .Distinct(x => x.Model, Builders<LlmRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var statuses = new[] { "running", "succeeded", "failed", "cancelled" };

        return Ok(ApiResponse<object>.Ok(new { providers, models, statuses }));
    }

    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 30,
        [FromQuery] DateTime? from = null,
        [FromQuery] DateTime? to = null,
        [FromQuery] string? provider = null,
        [FromQuery] string? model = null,
        [FromQuery] string? requestId = null,
        [FromQuery] string? groupId = null,
        [FromQuery] string? sessionId = null,
        [FromQuery] string? status = null)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 200);

        var filter = Builders<LlmRequestLog>.Filter.Empty;
        if (from.HasValue) filter &= Builders<LlmRequestLog>.Filter.Gte(x => x.StartedAt, from.Value);
        if (to.HasValue) filter &= Builders<LlmRequestLog>.Filter.Lte(x => x.StartedAt, to.Value);
        if (!string.IsNullOrWhiteSpace(provider)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Provider, provider);
        if (!string.IsNullOrWhiteSpace(model)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Model, model);
        if (!string.IsNullOrWhiteSpace(requestId)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.RequestId, requestId);
        if (!string.IsNullOrWhiteSpace(groupId)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.GroupId, groupId);
        if (!string.IsNullOrWhiteSpace(sessionId)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.SessionId, sessionId);
        if (!string.IsNullOrWhiteSpace(status)) filter &= Builders<LlmRequestLog>.Filter.Eq(x => x.Status, status);

        var total = await _db.LlmRequestLogs.CountDocumentsAsync(filter);
        var items = await _db.LlmRequestLogs.Find(filter)
            .SortByDescending(x => x.StartedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .Project(x => new
            {
                x.Id,
                x.RequestId,
                x.Provider,
                x.Model,
                x.GroupId,
                x.SessionId,
                x.ViewRole,
                x.Status,
                x.StartedAt,
                x.FirstByteAt,
                x.EndedAt,
                x.DurationMs,
                x.StatusCode,
                x.InputTokens,
                x.OutputTokens,
                x.CacheCreationInputTokens,
                x.CacheReadInputTokens,
                x.Error
            })
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Detail(string id)
    {
        var log = await _db.LlmRequestLogs.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (log == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "日志不存在"));

        return Ok(ApiResponse<LlmRequestLog>.Ok(log));
    }
}

