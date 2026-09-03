using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
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
    private readonly Services.Mcp.McpUsageService _usage;

    public McpConsoleController(
        MongoDbContext db,
        IAgentApiKeyService keyService,
        IAdminPermissionService permissions,
        Services.Mcp.McpUsageService usage)
    {
        _db = db;
        _keyService = keyService;
        _permissions = permissions;
        _usage = usage;
    }

    /// <summary>
    /// MCP 端点地址 —— 用户要把它复制进客户端配置，所以必须是对外真实可达的那个。
    ///
    /// 不能用 Request.Scheme/Host：nginx 终止 TLS 后转给 Kestrel 的是明文 HTTP，
    /// 直接拼会给出一个 http:// 的地址，粘进客户端就连不上。走转发头解析。
    /// </summary>
    private string BuildEndpointUrl() => $"{Request.ResolveExternalBaseUrl()}/api/mcp";

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
        // 「已授权」要跟鉴权口径一致：受权限位把关的 scope，权限被回收后鉴权时就会被剥掉，
        // 面板不能还显示成已授权 —— 否则用户看到的和智能体实际能用的是两回事。
        var grantedScopes = activeKeys.SelectMany(k => k.Scopes ?? new List<string>())
            .Where(s => EffectiveForOwner(s, ownedPermissions))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var since = McpUsageService.TodayStartUtc();
        // 计数走聚合，不再靠「取最近 N 条再在内存里数」：按每分钟 60 次的上限，
        // 十几分钟就能超过任何截断阈值，之后面板会系统性少报。列表只取要展示的那几条。
        var tally = await TodayTallyAsync(userId, since, ct);
        var recentLogs = await RecentLogsAsync(userId, since, 5, ct);

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
                // 我自己有没有这块能力的权限位 —— 没有的话向导里勾了也签不出密钥，得先说清楚。
                // 不受权限位把关的能力（海鲜市场、知识库这类老 scope）恒为可用：它们的闸门在接口自己身上，
                // 拿权限位去判会把「其实签得出来」的能力显示成灰的。
                availableToMe = !McpCapabilityCatalog.IsPermissionChecked(cap)
                    || scopes.Any(s => McpCapabilityCatalog.PermissionsAllowScope(ownedPermissions, s)),
                granted = scopes.Any(s => McpCapabilityCatalog.ScopeSatisfies(grantedScopes, s)),
                todayCalls = tally.ByCapability.TryGetValue(cap.Key, out var capCalls) ? capCalls : 0,
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

        var usageByKey = new Dictionary<string, (int Images, int Writes)>(StringComparer.Ordinal);
        foreach (var k in keys)
            usageByKey[k.Id] = await _usage.GetTodayUsageAsync(k.Id, ct);

        var clients = keys.Select(k => new
        {
            keyId = k.Id,
            name = k.Name,
            keyPrefix = k.KeyPrefix,
            scopes = k.Scopes ?? new List<string>(),
            isActive = k.IsActive,
            expiresAt = k.ExpiresAt,
            lastUsedAt = k.LastUsedAt,
            todayCalls = tally.ByKey.TryGetValue(k.Id, out var keyCalls) ? keyCalls : 0,
            dailyImageQuota = k.McpDailyImageQuota ?? McpUsageService.DefaultDailyImageQuota,
            dailyWriteQuota = k.McpDailyWriteQuota ?? McpUsageService.DefaultDailyWriteQuota,
            rateLimitPerMin = k.McpRateLimitPerMin ?? McpUsageService.DefaultRateLimitPerMin,
            // 已用数读闸门那份计数器，不再由日志推算：两边口径必须是同一个，
            // 否则面板显示还剩很多、智能体那边却已经被挡（或反过来）。
            todayImages = usageByKey.TryGetValue(k.Id, out var u1) ? u1.Images : 0,
            todayWrites = usageByKey.TryGetValue(k.Id, out var u2) ? u2.Writes : 0,
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
                calls = tally.Total,
                images = usageByKey.Values.Sum(u => u.Images),
                writes = usageByKey.Values.Sum(u => u.Writes),
                denied = tally.ByStatus.TryGetValue("denied", out var denied) ? denied : 0,
                failed = tally.ByStatus.TryGetValue("error", out var failed) ? failed : 0,
            },
            recentCalls = recentLogs.Select(ToLogDto),
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

        // 与 /api/mcp 的 tools/list 同口径：权限被回收的 scope 在鉴权时就被剥掉了，
        // 自检不能照着存下来的 scope 报一串对方其实看不见的工具。
        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);
        var ownedPermissions = await _permissions.GetEffectivePermissionsAsync(userId, isRoot, ct);
        var scopes = (key.Scopes ?? new List<string>())
            .Where(s => EffectiveForOwner(s, ownedPermissions))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
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

    /// <summary>
    /// 这个 scope 此刻对密钥主人还成立吗。受权限位把关的按当前权限判，其余（老 scope）原样成立。
    /// 与 ApiKeyAuthenticationHandler 的剥离逻辑同一口径，面板才不会跟实际能力对不上。
    /// </summary>
    private static bool EffectiveForOwner(string scope, IReadOnlyList<string> ownedPermissions)
        => !McpCapabilityCatalog.PermissionCheckedScopes.Contains(scope)
           || McpCapabilityCatalog.PermissionsAllowScope(ownedPermissions, scope);

    private sealed record TodayTally(
        long Total,
        IReadOnlyDictionary<string, long> ByStatus,
        IReadOnlyDictionary<string, long> ByKey,
        IReadOnlyDictionary<string, long> ByCapability);

    private FilterDefinition<McpCallLog> TodayFilter(string userId, DateTime since)
    {
        var f = Builders<McpCallLog>.Filter;
        return f.And(
            f.Eq(x => x.OwnerUserId, userId),
            f.Eq(x => x.DeploymentSlug, DeploymentScope.Current),
            f.Gte(x => x.CreatedAt, since));
    }

    /// <summary>今日计数：交给 Mongo 分组统计，条数再多也是准的。</summary>
    private async Task<TodayTally> TodayTallyAsync(string userId, DateTime since, CancellationToken ct)
    {
        var groups = await _db.McpCallLogs.Aggregate()
            .Match(TodayFilter(userId, since))
            .Group(new BsonDocument
            {
                { "_id", new BsonDocument
                    {
                        { "status", "$Status" },
                        { "keyId", "$KeyId" },
                        { "capability", "$Capability" },
                    }
                },
                { "n", new BsonDocument("$sum", 1) },
            })
            .ToListAsync(ct);

        long total = 0;
        var byStatus = new Dictionary<string, long>(StringComparer.Ordinal);
        var byKey = new Dictionary<string, long>(StringComparer.Ordinal);
        var byCapability = new Dictionary<string, long>(StringComparer.Ordinal);

        foreach (var doc in groups)
        {
            var n = doc["n"].ToInt64();
            total += n;
            var id = doc["_id"].AsBsonDocument;
            Accumulate(byStatus, ReadKey(id, "status"), n);
            Accumulate(byKey, ReadKey(id, "keyId"), n);
            Accumulate(byCapability, ReadKey(id, "capability"), n);
        }

        return new TodayTally(total, byStatus, byKey, byCapability);

        static string? ReadKey(BsonDocument id, string name)
            => id.TryGetValue(name, out var v) && !v.IsBsonNull ? v.AsString : null;

        static void Accumulate(Dictionary<string, long> map, string? key, long n)
        {
            if (string.IsNullOrEmpty(key)) return;
            map[key] = map.TryGetValue(key, out var cur) ? cur + n : n;
        }
    }

    private async Task<List<McpCallLog>> RecentLogsAsync(string userId, DateTime since, int limit, CancellationToken ct)
        => await _db.McpCallLogs.Find(TodayFilter(userId, since))
            .SortByDescending(x => x.CreatedAt)
            .Limit(limit)
            .ToListAsync(ct);

    private static object ToLogDto(McpCallLog l) => new
    {
        id = l.Id,
        keyId = l.KeyId,
        keyName = l.KeyName,
        toolName = l.ToolName,
        capability = l.Capability,
        status = l.Status,
        isWrite = l.IsWrite,
        deduplicated = l.Deduplicated,
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
