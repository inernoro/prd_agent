using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using AppCallerRegistry = PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - OpenApi 对外网关。
///
/// 职责：把「哪个客户(Key) 用哪个固定模型/池」列出来，避免改总池误伤客户；
/// 并支持设置/清除每个 Key 的 chat / image 绑定、查看可绑定的模型池、查看调用日志。
///
/// 权限复用 OpenPlatformManage（与「开放平台」语义一致）。
/// </summary>
[ApiController]
[Route("api/open-api")]
[Authorize]
[AdminController("open-platform", AdminPermissionCatalog.OpenPlatformManage)]
public class AdminOpenApiController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly IOpenApiUsageService _usage;
    private readonly ILogger<AdminOpenApiController> _logger;

    public AdminOpenApiController(MongoDbContext db, ILlmGateway gateway, IOpenApiUsageService usage, ILogger<AdminOpenApiController> logger)
    {
        _db = db;
        _gateway = gateway;
        _usage = usage;
        _logger = logger;
    }

    /// <summary>列出所有授予 open-api:call 的 Key 及其固定模型绑定（含实际解析结果）。</summary>
    [HttpGet("bindings")]
    public async Task<IActionResult> ListBindings(CancellationToken ct)
    {
        var keys = await _db.AgentApiKeys
            .Find(k => k.Scopes.Contains(OpenApiController.ScopeCall))
            .ToListAsync(ct);

        var userIds = keys.Select(k => k.OwnerUserId).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        var users = await _db.Users.Find(u => userIds.Contains(u.UserId)).ToListAsync(ct);
        var userNameById = users
            .Where(u => !string.IsNullOrWhiteSpace(u.UserId))
            .ToDictionary(
                u => u.UserId,
                u => !string.IsNullOrWhiteSpace(u.Username) ? u.Username : (u.Email ?? u.UserId));

        var result = new List<object>();
        foreach (var k in keys)
        {
            // 默认（白名单第一个）的实际解析，供管理快速核对客户当前默认拿到的是哪个模型
            var chatResolved = await SafeResolveAsync(AppCallerRegistry.OpenApi.Proxy.Chat, ModelTypes.Chat, k.OpenApiChatModels.FirstOrDefault(), ct);
            var imageResolved = await SafeResolveAsync(AppCallerRegistry.OpenApi.Proxy.Generation, ModelTypes.ImageGen, k.OpenApiImageModels.FirstOrDefault(), ct);
            var usage = await _usage.GetUsageAsync(k.Id, ct);
            result.Add(new
            {
                keyId = k.Id,
                name = k.Name,
                ownerUserId = k.OwnerUserId,
                ownerName = userNameById.TryGetValue(k.OwnerUserId, out var n) ? n : k.OwnerUserId,
                isActive = k.IsActive,
                chatModels = k.OpenApiChatModels,
                imageModels = k.OpenApiImageModels,
                chatResolvedModel = chatResolved.model,
                chatResolutionType = chatResolved.type,
                chatIsFallback = chatResolved.isFallback,
                imageResolvedModel = imageResolved.model,
                imageResolutionType = imageResolved.type,
                dailyTokenQuota = k.OpenApiDailyTokenQuota,
                dailyRequestQuota = k.OpenApiDailyRequestQuota,
                rateLimitPerMin = k.OpenApiRateLimitPerMin,
                todayRequests = usage.TodayRequests,
                todayTokens = usage.TodayTokens,
                totalRequests = k.TotalRequests,
                lastUsedAt = k.LastUsedAt
            });
        }

        return Ok(ApiResponse<object>.Ok(result));
    }

    /// <summary>设置某 Key 的 chat / image 模型白名单（空数组=清除→回落默认池）+ 限额。第一个为客户默认。</summary>
    [HttpPut("bindings/{keyId}")]
    public async Task<IActionResult> SetBinding(string keyId, [FromBody] SetBindingRequest req, CancellationToken ct)
    {
        var key = await _db.AgentApiKeys.Find(k => k.Id == keyId).FirstOrDefaultAsync(ct);
        if (key == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "Key 不存在"));

        var update = Builders<AgentApiKey>.Update
            .Set(k => k.OpenApiChatModels, CleanList(req.ChatModels))
            .Set(k => k.OpenApiImageModels, CleanList(req.ImageModels))
            .Set(k => k.OpenApiDailyTokenQuota, req.DailyTokenQuota)
            .Set(k => k.OpenApiDailyRequestQuota, req.DailyRequestQuota)
            .Set(k => k.OpenApiRateLimitPerMin, req.RateLimitPerMin);

        await _db.AgentApiKeys.UpdateOneAsync(k => k.Id == keyId, update, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { keyId, ok = true }));
    }

    /// <summary>列出可绑定的模型池（chat + generation），供管理 UI 选择固定模型/池。</summary>
    [HttpGet("pools")]
    public async Task<IActionResult> ListPools(CancellationToken ct)
    {
        var groups = await _db.ModelGroups
            .Find(g => g.ModelType == ModelTypes.Chat || g.ModelType == ModelTypes.ImageGen)
            .SortBy(g => g.Priority)
            .ToListAsync(ct);

        var pools = groups.Select(g => new
        {
            id = g.Id,
            name = g.Name,
            code = g.Code,
            modelType = g.ModelType,
            isDefault = g.IsDefaultForType,
            models = (g.Models ?? new List<ModelGroupItem>()).Select(m => m.ModelId).ToList()
        });

        return Ok(ApiResponse<object>.Ok(pools));
    }

    /// <summary>最近调用日志（监控/排障）。</summary>
    [HttpGet("logs")]
    public async Task<IActionResult> ListLogs([FromQuery] string? keyId, [FromQuery] int limit = 100, CancellationToken ct = default)
    {
        var filter = string.IsNullOrWhiteSpace(keyId)
            ? Builders<OpenApiRequestLog>.Filter.Empty
            : Builders<OpenApiRequestLog>.Filter.Eq(l => l.KeyId, keyId);

        var logs = await _db.OpenApiRequestLogs
            .Find(filter)
            .SortByDescending(l => l.CreatedAt)
            .Limit(Math.Clamp(limit, 1, 500))
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(logs));
    }

    private async Task<(string? model, string? type, bool isFallback)> SafeResolveAsync(
        string code, string modelType, string? binding, CancellationToken ct)
    {
        try
        {
            var res = await _gateway.ResolveModelAsync(code, modelType,
                expectedModel: string.IsNullOrWhiteSpace(binding) ? null : binding, ct);
            return res.Success ? (res.ActualModel, res.ResolutionType, res.IsFallback) : (null, "NotFound", false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[AdminOpenApi] 解析 {Code} 失败", code);
            return (null, "Error", false);
        }
    }

    private static List<string> CleanList(List<string>? v)
        => (v ?? new List<string>()).Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()).Distinct().ToList();

    public class SetBindingRequest
    {
        public List<string>? ChatModels { get; set; }
        public List<string>? ImageModels { get; set; }
        public long? DailyTokenQuota { get; set; }
        public long? DailyRequestQuota { get; set; }
        public int? RateLimitPerMin { get; set; }
    }
}
