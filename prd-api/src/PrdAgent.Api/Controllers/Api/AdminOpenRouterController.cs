using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using AppCallerRegistry = PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - OpenRouter 对外网关。
///
/// 职责：把「哪个客户(Key) 用哪个固定模型/池」列出来，避免改总池误伤客户；
/// 并支持设置/清除每个 Key 的 chat / image 绑定、查看可绑定的模型池、查看调用日志。
///
/// 权限复用 OpenPlatformManage（与「开放平台」语义一致）。
/// </summary>
[ApiController]
[Route("api/open-router")]
[Authorize]
[AdminController("open-platform", AdminPermissionCatalog.OpenPlatformManage)]
public class AdminOpenRouterController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<AdminOpenRouterController> _logger;

    public AdminOpenRouterController(MongoDbContext db, ILlmGateway gateway, ILogger<AdminOpenRouterController> logger)
    {
        _db = db;
        _gateway = gateway;
        _logger = logger;
    }

    /// <summary>列出所有授予 open-router:call 的 Key 及其固定模型绑定（含实际解析结果）。</summary>
    [HttpGet("bindings")]
    public async Task<IActionResult> ListBindings(CancellationToken ct)
    {
        var keys = await _db.AgentApiKeys
            .Find(k => k.Scopes.Contains(OpenRouter.OpenRouterController.ScopeCall))
            .ToListAsync(ct);

        var userIds = keys.Select(k => k.OwnerUserId).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        var users = await _db.Users.Find(u => userIds.Contains(u.Id!)).ToListAsync(ct);
        var userNameById = users
            .Where(u => !string.IsNullOrWhiteSpace(u.Id))
            .ToDictionary(
                u => u.Id!,
                u => !string.IsNullOrWhiteSpace(u.Username) ? u.Username : (u.Email ?? u.Id!));

        var result = new List<object>();
        foreach (var k in keys)
        {
            var chatResolved = await SafeResolveAsync(AppCallerRegistry.OpenRouter.Proxy.Chat, ModelTypes.Chat, k.OpenRouterChatBinding, ct);
            var imageResolved = await SafeResolveAsync(AppCallerRegistry.OpenRouter.Proxy.Generation, ModelTypes.ImageGen, k.OpenRouterImageBinding, ct);
            result.Add(new
            {
                keyId = k.Id,
                name = k.Name,
                ownerUserId = k.OwnerUserId,
                ownerName = userNameById.TryGetValue(k.OwnerUserId, out var n) ? n : k.OwnerUserId,
                isActive = k.IsActive,
                chatBinding = k.OpenRouterChatBinding,
                imageBinding = k.OpenRouterImageBinding,
                chatResolvedModel = chatResolved.model,
                chatResolutionType = chatResolved.type,
                chatIsFallback = chatResolved.isFallback,
                imageResolvedModel = imageResolved.model,
                imageResolutionType = imageResolved.type,
                dailyTokenQuota = k.OpenRouterDailyTokenQuota,
                dailyRequestQuota = k.OpenRouterDailyRequestQuota,
                totalRequests = k.TotalRequests,
                lastUsedAt = k.LastUsedAt
            });
        }

        return Ok(ApiResponse<object>.Ok(result));
    }

    /// <summary>设置/清除某 Key 的 chat / image 绑定（传 null 或空串=清除→回落默认池）。</summary>
    [HttpPut("bindings/{keyId}")]
    public async Task<IActionResult> SetBinding(string keyId, [FromBody] SetBindingRequest req, CancellationToken ct)
    {
        var key = await _db.AgentApiKeys.Find(k => k.Id == keyId).FirstOrDefaultAsync(ct);
        if (key == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "Key 不存在"));

        var update = Builders<AgentApiKey>.Update
            .Set(k => k.OpenRouterChatBinding, Normalize(req.ChatBinding))
            .Set(k => k.OpenRouterImageBinding, Normalize(req.ImageBinding))
            .Set(k => k.OpenRouterDailyTokenQuota, req.DailyTokenQuota)
            .Set(k => k.OpenRouterDailyRequestQuota, req.DailyRequestQuota);

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
            ? Builders<OpenRouterRequestLog>.Filter.Empty
            : Builders<OpenRouterRequestLog>.Filter.Eq(l => l.KeyId, keyId);

        var logs = await _db.OpenRouterRequestLogs
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
            _logger.LogWarning(ex, "[AdminOpenRouter] 解析 {Code} 失败", code);
            return (null, "Error", false);
        }
    }

    private static string? Normalize(string? v) => string.IsNullOrWhiteSpace(v) ? null : v.Trim();

    public class SetBindingRequest
    {
        public string? ChatBinding { get; set; }
        public string? ImageBinding { get; set; }
        public long? DailyTokenQuota { get; set; }
        public long? DailyRequestQuota { get; set; }
    }
}
