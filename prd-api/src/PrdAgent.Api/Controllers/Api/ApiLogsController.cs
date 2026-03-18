using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Attributes;
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

    private sealed class MetaUser
    {
        public string UserId { get; init; } = string.Empty;
        public string? Username { get; init; }
    }

    /// <summary>
    /// 应用名称 → 中文显示名映射（AppNames 常量 + 客户端上报的 appName）
    /// </summary>
    private static readonly Dictionary<string, string> AppDisplayNames = new(StringComparer.OrdinalIgnoreCase)
    {
        [AppNames.PrdAgent] = AppNames.PrdAgentDisplay,
        [AppNames.VisualAgent] = AppNames.VisualAgentDisplay,
        [AppNames.LiteraryAgent] = AppNames.LiteraryAgentDisplay,
        [AppNames.ModelLab] = AppNames.ModelLabDisplay,
        [AppNames.OpenPlatform] = AppNames.OpenPlatformDisplay,
        [AppNames.Desktop] = AppNames.DesktopDisplay,
        [AppNames.System] = AppNames.SystemDisplay,
        [AppNames.Watermark] = AppNames.WatermarkDisplay,
        [AppNames.Llm] = AppNames.LlmDisplay,
        [AppNames.ReportAgent] = AppNames.ReportAgentDisplay,
        // 客户端上报的 appName（来自 X-App-Name header / JWT claim）
        ["ai-toolbox"] = "AI 百宝箱",
        ["arena-agent"] = "AI 竞技场",
        ["defect-agent"] = "缺陷管理",
        ["lab-agent"] = "模型实验室",
        ["video-agent"] = "视频生成",
        ["open-platform-agent"] = "开放平台",
        ["workflow-agent"] = "工作流引擎",
        ["shortcuts-agent"] = "快捷指令",
    };

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

        // 获取近期活跃的 userIds（最多 200 个），并解析用户名
        var rawUserIds = (await _db.ApiRequestLogs
                .Distinct(x => x.UserId, Builders<ApiRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x!.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(200)
            .ToArray();

        var dbUsers = await _db.Users.Find(u => rawUserIds.Contains(u.UserId))
            .Project(u => new MetaUser { UserId = u.UserId, Username = u.Username })
            .ToListAsync();

        var users = dbUsers.ToList();
        var knownUserIds = new HashSet<string>(users.Select(x => x.UserId), StringComparer.OrdinalIgnoreCase);
        foreach (var uid in rawUserIds)
        {
            if (!knownUserIds.Contains(uid))
            {
                users.Add(new MetaUser { UserId = uid });
            }
        }
        users = users
            .OrderBy(x => x.Username ?? string.Empty, StringComparer.OrdinalIgnoreCase)
            .ThenBy(x => x.UserId, StringComparer.OrdinalIgnoreCase)
            .ToList();

        // 获取 appNames 并映射中文显示名
        var rawAppNames = (await _db.ApiRequestLogs
                .Distinct(x => x.AppName, Builders<ApiRequestLog>.Filter.Empty)
                .ToListAsync())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var appNames = rawAppNames.Select(name => new
        {
            value = name,
            displayName = AppDisplayNames.TryGetValue(name!, out var display) ? display : name
        }).OrderBy(x => x.displayName, StringComparer.OrdinalIgnoreCase).ToArray();

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

        return Ok(ApiResponse<object>.Ok(new { clientTypes, methods, users, appNames, directions, statuses }));
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

        // 批量解析用户名（避免 N+1 查询）
        var listUserIds = rawItems.Select(x => x.UserId).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToArray();
        var listUsers = await _db.Users.Find(u => listUserIds.Contains(u.UserId))
            .Project(u => new { u.UserId, u.Username })
            .ToListAsync();
        var userNameMap = listUsers.ToDictionary(u => u.UserId, u => u.Username, StringComparer.OrdinalIgnoreCase);

        var uaRe = new Regex(@"\s+", RegexOptions.Compiled);

        var items = rawItems.Select(x => new
        {
            x.Id,
            x.RequestId,
            x.StartedAt,
            x.EndedAt,
            x.DurationMs,
            x.UserId,
            username = userNameMap.TryGetValue(x.UserId, out var uname) ? uname : null,
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

        // 解析用户名
        string? username = null;
        if (!string.IsNullOrWhiteSpace(log.UserId))
        {
            var user = await _db.Users.Find(u => u.UserId == log.UserId)
                .Project(u => new { u.Username })
                .FirstOrDefaultAsync();
            username = user?.Username;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            log.Id,
            log.RequestId,
            log.StartedAt,
            log.EndedAt,
            log.DurationMs,
            log.Method,
            log.Path,
            log.Query,
            log.AbsoluteUrl,
            log.Protocol,
            log.RequestContentType,
            log.ResponseContentType,
            log.StatusCode,
            log.ApiSummary,
            log.ErrorCode,
            log.UserId,
            username,
            log.GroupId,
            log.SessionId,
            log.ClientIp,
            log.UserAgent,
            log.ClientType,
            log.ClientId,
            log.AppId,
            log.AppName,
            log.RequestBody,
            log.RequestBodyTruncated,
            log.Curl,
            log.IsEventStream,
            log.Direction,
            log.Status,
            log.ResponseBody,
            log.ResponseBodyTruncated,
            log.ResponseBodyBytes,
            log.TargetHost
        }));
    }
}

