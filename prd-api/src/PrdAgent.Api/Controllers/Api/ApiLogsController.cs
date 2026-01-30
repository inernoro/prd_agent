using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Text.RegularExpressions;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 系统 API 请求日志（用户发起的请求）
/// </summary>
[ApiController]
[Route("api/logs/api")]
[Authorize]
[AdminController("logs", AdminPermissionCatalog.LogsRead)]
public class ApiLogsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public ApiLogsController(MongoDbContext db)
    {
        _db = db;
    }

    private static string Truncate(string? s, int maxChars)
    {
        var raw = (s ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(raw)) return string.Empty;
        if (raw.Length <= maxChars) return raw;
        return raw[..maxChars] + "…";
    }

    [HttpGet("meta")]
    public async Task<IActionResult> Meta()
    {
        var clientTypes = (await _db.ApiRequestLogs
                .Distinct(x => x.ClientType, Builders<ApiRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var methods = new[] { "GET", "POST", "PUT", "PATCH", "DELETE" };

        // 获取近期活跃的 userIds（最多 200 个）
        var userIds = (await _db.ApiRequestLogs
                .Distinct(x => x.UserId, Builders<ApiRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .Take(200)
            .ToArray();

        // 获取 appNames
        var appNames = (await _db.ApiRequestLogs
                .Distinct(x => x.AppName, Builders<ApiRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        // 获取 directions（入站/出站）
        var directions = (await _db.ApiRequestLogs
                .Distinct(x => x.Direction, Builders<ApiRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        // 获取 statuses（请求状态）
        var statuses = (await _db.ApiRequestLogs
                .Distinct(x => x.Status, Builders<ApiRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        return Ok(ApiResponse<object>.Ok(new { clientTypes, methods, userIds, appNames, directions, statuses }));
    }

    /// <summary>
    /// 噪声路径列表（excludeNoise=true 时排除）
    /// </summary>
    private static readonly string[] NoisePaths = new[]
    {
        "/api/v1/auth/refresh",
        "/api/logs/llm",
        "/api/logs/llm/meta",
        "/api/logs/api",
        "/api/logs/api/meta",
    };

    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 30,
        [FromQuery] DateTime? from = null,
        [FromQuery] DateTime? to = null,
        [FromQuery] string? userId = null,
        [FromQuery] string? method = null,
        [FromQuery] string? path = null,
        [FromQuery] int? statusCode = null,
        [FromQuery] string? requestId = null,
        [FromQuery] string? clientType = null,
        [FromQuery] string? clientId = null,
        [FromQuery] string? groupId = null,
        [FromQuery] string? sessionId = null,
        [FromQuery] string? appName = null,
        [FromQuery] string? direction = null,
        [FromQuery] string? status = null,
        [FromQuery] bool excludeNoise = false,
        [FromQuery] bool excludeRunning = false)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 10, 200);

        var filter = Builders<ApiRequestLog>.Filter.Empty;
        if (from.HasValue) filter &= Builders<ApiRequestLog>.Filter.Gte(x => x.StartedAt, from.Value);
        if (to.HasValue) filter &= Builders<ApiRequestLog>.Filter.Lte(x => x.StartedAt, to.Value);
        if (!string.IsNullOrWhiteSpace(userId)) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.UserId, userId);
        if (!string.IsNullOrWhiteSpace(method)) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.Method, method.ToUpperInvariant());
        if (!string.IsNullOrWhiteSpace(path)) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.Path, path);
        if (statusCode.HasValue) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.StatusCode, statusCode.Value);
        if (!string.IsNullOrWhiteSpace(requestId)) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.RequestId, requestId);
        if (!string.IsNullOrWhiteSpace(clientType)) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.ClientType, clientType);
        if (!string.IsNullOrWhiteSpace(clientId)) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.ClientId, clientId);
        if (!string.IsNullOrWhiteSpace(groupId)) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.GroupId, groupId);
        if (!string.IsNullOrWhiteSpace(appName)) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.AppName, appName);
        if (!string.IsNullOrWhiteSpace(sessionId)) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.SessionId, sessionId);
        if (!string.IsNullOrWhiteSpace(direction)) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.Direction, direction);
        if (!string.IsNullOrWhiteSpace(status)) filter &= Builders<ApiRequestLog>.Filter.Eq(x => x.Status, status);
        if (excludeNoise) filter &= Builders<ApiRequestLog>.Filter.Nin(x => x.Path, NoisePaths);
        if (excludeRunning) filter &= Builders<ApiRequestLog>.Filter.Ne(x => x.Status, "running");

        var total = await _db.ApiRequestLogs.CountDocumentsAsync(filter);
        var rawItems = await _db.ApiRequestLogs.Find(filter)
            .SortByDescending(x => x.StartedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .Project(x => new
            {
                x.Id,
                x.RequestId,
                x.StartedAt,
                x.EndedAt,
                x.DurationMs,
                x.UserId,
                x.GroupId,
                x.SessionId,
                x.Method,
                x.Path,
                x.Query,
                x.AbsoluteUrl,
                x.StatusCode,
                x.RequestContentType,
                x.ResponseContentType,
                x.ApiSummary,
                x.ErrorCode,
                x.ClientType,
                x.ClientId,
                x.AppId,
                x.AppName,
                x.ClientIp,
                x.UserAgent,
                x.IsEventStream,
                x.RequestBody,
                x.Curl,
                x.RequestBodyTruncated,
                x.Direction,
                x.Status
                // 注意：不投影 ResponseBody，避免列表刷新时循环增长
            })
            .ToListAsync();

        var uaRe = new Regex(@"\s+", RegexOptions.Compiled);

        var items = rawItems.Select(x => new
        {
            x.Id,
            x.RequestId,
            x.StartedAt,
            x.EndedAt,
            x.DurationMs,
            x.UserId,
            x.GroupId,
            x.SessionId,
            x.Method,
            x.Path,
            x.Query,
            x.AbsoluteUrl,
            x.StatusCode,
            x.RequestContentType,
            x.ResponseContentType,
            x.ApiSummary,
            x.ErrorCode,
            x.ClientType,
            x.ClientId,
            x.AppId,
            x.AppName,
            x.ClientIp,
            userAgentPreview = Truncate(uaRe.Replace(x.UserAgent ?? string.Empty, " ").Trim(), 180),
            x.IsEventStream,
            requestBodyPreview = Truncate(x.RequestBody, 800),
            curlPreview = Truncate(x.Curl, 800),
            x.RequestBodyTruncated,
            x.Direction,
            x.Status
            // 注意：responseBody 只在 Detail 接口返回，避免列表循环增长
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Detail(string id)
    {
        var log = await _db.ApiRequestLogs.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (log == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "日志不存在"));
        return Ok(ApiResponse<ApiRequestLog>.Ok(log));
    }
}

