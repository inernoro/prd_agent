using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 智能体接入台 —— 用户自己看的那一页：我授权了什么、连着哪几台客户端、它们刚才做了什么。
///
/// 鉴权走用户 JWT（这是给人用的界面，不是给智能体用的）。智能体那侧走 /api/mcp。
///
/// 三个问题必须在这一页里答完，用户不该再去别处翻：
///   1. 我的智能体能替我做什么（能力卡 + 每块能力挂着哪些工具）
///   2. 它刚才做了什么（调用记录 + 产物直达）
///   3. 它还能做多少（今日额度）
/// </summary>
[ApiController]
[Route("api/mcp-console")]
[Authorize]
public class McpConsoleController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IAgentApiKeyService _keyService;
    private readonly IAdminPermissionService _permissions;

    public McpConsoleController(MongoDbContext db, IAgentApiKeyService keyService, IAdminPermissionService permissions)
    {
        _db = db;
        _keyService = keyService;
        _permissions = permissions;
    }

    /// <summary>
    /// MCP 端点地址。反代把 /api/* 转给后端，所以这里读到的 Host 就是用户看到的域名。
    /// 不自己拼预览域名（那是 cdscli 的活），只如实回当前请求打进来的地址。
    /// </summary>
    private string BuildEndpointUrl() => $"{Request.Scheme}://{Request.Host}/api/mcp";

    [HttpGet("overview")]
    public async Task<IActionResult> Overview(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);
        var ownedPermissions = await _permissions.GetEffectivePermissionsAsync(userId, isRoot, ct);

        var keys = (await _keyService.ListByOwnerAsync(userId, ct))
            .Where(k => k.RevokedAt == null)
            .ToList();
        var activeKeys = keys.Where(k => k.IsActive).ToList();
        var grantedScopes = activeKeys.SelectMany(k => k.Scopes ?? new List<string>())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var since = McpUsageService.TodayStartUtc();
        var todayLogs = await TodayLogsAsync(userId, since, ct);

        var capabilities = McpCapabilityCatalog.All.Select(cap =>
        {
            var tools = McpCapabilityCatalog.ToolsOf(cap);
            var scopes = cap.AllScopes().ToList();
            return new
            {
                key = cap.Key,
                title = cap.Title,
                summary = cap.Summary,
                readScope = cap.ReadScope,
                writeScope = cap.WriteScope,
                writeNeedsApproval = cap.WriteNeedsApproval,
                // 我自己有没有这块能力的权限位 —— 没有的话向导里勾了也签不出密钥，得先说清楚
                availableToMe = scopes.Any(s => McpCapabilityCatalog.PermissionsAllowScope(ownedPermissions, s)),
                granted = scopes.Any(s => McpCapabilityCatalog.ScopeSatisfies(grantedScopes, s)),
                todayCalls = todayLogs.Count(l => l.Capability == cap.Key),
                tools = tools.Select(t => new
                {
                    name = t.Name,
                    description = t.Description,
                    requiredScope = t.RequiredScope,
                    isWrite = McpUsageService.IsWriteTool(t),
                    granted = McpCapabilityCatalog.ScopeSatisfies(grantedScopes, t.RequiredScope),
                }),
            };
        }).ToList();

        var clients = keys.Select(k => new
        {
            keyId = k.Id,
            name = k.Name,
            keyPrefix = k.KeyPrefix,
            scopes = k.Scopes ?? new List<string>(),
            isActive = k.IsActive,
            expiresAt = k.ExpiresAt,
            lastUsedAt = k.LastUsedAt,
            todayCalls = todayLogs.Count(l => l.KeyId == k.Id),
            dailyImageQuota = k.McpDailyImageQuota ?? McpUsageService.DefaultDailyImageQuota,
            dailyWriteQuota = k.McpDailyWriteQuota ?? McpUsageService.DefaultDailyWriteQuota,
            rateLimitPerMin = k.McpRateLimitPerMin ?? McpUsageService.DefaultRateLimitPerMin,
            todayImages = todayLogs.Where(l => l.KeyId == k.Id && l.Status == "success").Sum(l => l.ImageCount),
            todayWrites = todayLogs.Count(l => l.KeyId == k.Id && l.Status == "success" && l.IsWrite),
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            endpointUrl = BuildEndpointUrl(),
            capabilities,
            clients,
            today = new
            {
                // 「今天」按 UTC 自然日切，与额度口径一致；界面上要写明白，别让人以为是本地零点
                sinceUtc = since,
                calls = todayLogs.Count,
                images = todayLogs.Where(l => l.Status == "success").Sum(l => l.ImageCount),
                writes = todayLogs.Count(l => l.Status == "success" && l.IsWrite),
                denied = todayLogs.Count(l => l.Status == "denied"),
                failed = todayLogs.Count(l => l.Status == "error"),
            },
            recentCalls = todayLogs
                .OrderByDescending(l => l.CreatedAt)
                .Take(5)
                .Select(ToLogDto),
        }));
    }

    /// <summary>调用记录（分页，最新在前）。</summary>
    [HttpGet("calls")]
    public async Task<IActionResult> Calls(
        [FromQuery] string? keyId,
        [FromQuery] string? capability,
        [FromQuery] string? status,
        [FromQuery] int skip,
        [FromQuery] int limit,
        CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var resolvedLimit = limit is > 0 and <= 200 ? limit : 50;
        var resolvedSkip = skip > 0 ? skip : 0;

        var f = Builders<McpCallLog>.Filter;
        var filter = f.And(
            f.Eq(x => x.OwnerUserId, userId),
            f.Eq(x => x.DeploymentSlug, DeploymentScope.Current));
        if (!string.IsNullOrWhiteSpace(keyId)) filter = f.And(filter, f.Eq(x => x.KeyId, keyId));
        if (!string.IsNullOrWhiteSpace(capability)) filter = f.And(filter, f.Eq(x => x.Capability, capability));
        if (!string.IsNullOrWhiteSpace(status)) filter = f.And(filter, f.Eq(x => x.Status, status));

        var total = await _db.McpCallLogs.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.McpCallLogs.Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip(resolvedSkip)
            .Limit(resolvedLimit)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            total,
            skip = resolvedSkip,
            limit = resolvedLimit,
            items = items.Select(ToLogDto),
        }));
    }

    /// <summary>单条调用的完整记录（入参摘要、产物、失败原因）。</summary>
    [HttpGet("calls/{id}")]
    public async Task<IActionResult> CallDetail(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var log = await _db.McpCallLogs.Find(x => x.Id == id && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (log == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "记录不存在"));
        return Ok(ApiResponse<object>.Ok(ToLogDto(log)));
    }

    /// <summary>
    /// 能力自检：这把密钥现在能看到哪些工具。
    ///
    /// 服务端按 scope 直接算，与 /api/mcp 的 tools/list 同一个判据 —— 不发网络请求，
    /// 所以它回答的是「授权对不对」，不是「你的客户端能不能连上」。界面上要如实这么写。
    /// </summary>
    [HttpGet("keys/{keyId}/visible-tools")]
    public async Task<IActionResult> VisibleTools(string keyId, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var key = await _keyService.GetByIdAsync(keyId, ct);
        if (key == null || key.OwnerUserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "密钥不存在或无权访问"));

        var scopes = (key.Scopes ?? new List<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var visible = McpBuiltinTools.All
            .Where(t => McpCapabilityCatalog.ScopeSatisfies(scopes, t.RequiredScope))
            .Select(t => new
            {
                name = t.Name,
                description = t.Description,
                capability = McpCapabilityCatalog.ByScope(t.RequiredScope)?.Key,
                isWrite = McpUsageService.IsWriteTool(t),
            })
            .ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            endpointUrl = BuildEndpointUrl(),
            keyId = key.Id,
            keyName = key.Name,
            keyPrefix = key.KeyPrefix,
            isActive = key.IsActive && key.RevokedAt == null,
            expiresAt = key.ExpiresAt,
            toolCount = visible.Count,
            tools = visible,
        }));
    }

    private async Task<List<McpCallLog>> TodayLogsAsync(string userId, DateTime since, CancellationToken ct)
    {
        var f = Builders<McpCallLog>.Filter;
        var filter = f.And(
            f.Eq(x => x.OwnerUserId, userId),
            f.Eq(x => x.DeploymentSlug, DeploymentScope.Current),
            f.Gte(x => x.CreatedAt, since));
        return await _db.McpCallLogs.Find(filter).SortByDescending(x => x.CreatedAt).Limit(1000).ToListAsync(ct);
    }

    private static object ToLogDto(McpCallLog l) => new
    {
        id = l.Id,
        keyId = l.KeyId,
        keyName = l.KeyName,
        toolName = l.ToolName,
        capability = l.Capability,
        status = l.Status,
        isWrite = l.IsWrite,
        imageCount = l.ImageCount,
        httpStatus = l.HttpStatus,
        durationMs = l.DurationMs,
        argumentsPreview = l.ArgumentsPreview,
        errorMessage = l.ErrorMessage,
        artifact = l.ArtifactKind == null && l.ArtifactUrl == null ? null : new
        {
            kind = l.ArtifactKind,
            id = l.ArtifactId,
            url = l.ArtifactUrl,
            title = l.ArtifactTitle,
        },
        createdAt = l.CreatedAt,
    };
}
