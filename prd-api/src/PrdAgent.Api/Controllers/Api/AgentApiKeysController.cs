using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 用户管理自己的 AgentApiKey（海鲜市场开放接口 / Agent 开放入口 M2M 鉴权凭据）。
///
/// 鉴权：管理接口走用户 JWT。调用这些 API 的是"接入 AI" Dialog，不是 AI 本身。
/// 明文 Key 只在 create / regenerate 接口返回一次；后续只存哈希。
/// </summary>
[ApiController]
[Route("api/agent-api-keys")]
[Authorize]
public class AgentApiKeysController : ControllerBase
{
    // 固定 scope 白名单（市场开放接口核心 scope）
    private static readonly HashSet<string> FixedAllowedScopes = new(StringComparer.OrdinalIgnoreCase)
    {
        MarketplaceSkillsOpenApiController.ScopeRead,
        MarketplaceSkillsOpenApiController.ScopeWrite,
    };

    // 默认 TTL：365 天（符合需求"授权时间尽可能长"）
    private const int DefaultTtlDays = 365;
    // 续期：每次 +365 天
    private const int RenewTtlDays = 365;
    // 用户端允许的最大 TTL：1095 天（3 年）；更长需管理员
    private const int MaxTtlDays = 1095;

    private readonly IAgentApiKeyService _keyService;
    private readonly MongoDbContext _db;

    public AgentApiKeysController(IAgentApiKeyService keyService, MongoDbContext db)
    {
        _keyService = keyService;
        _db = db;
    }

    /// <summary>
    /// 判断 scope 字符串是否被允许。两类：
    /// 1. FixedAllowedScopes 硬编码的核心 scope
    /// 2. AgentScopeFormat.Pattern 匹配的 agent.* scope，且该 scope 必须
    ///    已经被某条 AgentOpenEndpoint 登记过（防止用户创建"空头"scope）
    /// </summary>
    private async Task<(bool ok, string? reason)> ValidateScopeAsync(string scope, CancellationToken ct)
    {
        if (FixedAllowedScopes.Contains(scope)) return (true, null);
        if (!AgentScopeFormat.Pattern.IsMatch(scope))
            return (false, $"scope 格式无效: {scope}（允许 {string.Join(" / ", FixedAllowedScopes)} 或 `agent.{{agent-key}}:{{action}}`）");

        var exists = await _db.AgentOpenEndpoints
            .Find(e => e.IsActive && e.RequiredScopes.Contains(scope))
            .AnyAsync(ct);
        return exists
            ? (true, null)
            : (false, $"scope `{scope}` 未被任何已登记的 Agent 开放接口引用，无法授予");
    }

    /// <summary>列出当前用户的所有 Key + 当前平台支持的 scope（含动态登记的 Agent scope）</summary>
    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var keys = await _keyService.ListByOwnerAsync(userId, ct);

        // 汇总 scope：固定 + AgentOpenEndpoint 登记的所有 agent.* scope
        var endpoints = await _db.AgentOpenEndpoints
            .Find(e => e.IsActive)
            .Project(e => new { e.AgentKey, e.Title, e.RequiredScopes })
            .ToListAsync(ct);

        var dynamicScopes = endpoints
            .SelectMany(e => e.RequiredScopes ?? new List<string>())
            .Where(s => !string.IsNullOrWhiteSpace(s) && AgentScopeFormat.Pattern.IsMatch(s))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(s => s)
            .ToList();

        var allowed = FixedAllowedScopes.Concat(dynamicScopes).ToArray();

        return Ok(ApiResponse<object>.Ok(new
        {
            items = keys.Select(ToDto),
            allowedScopes = allowed,
            agentEndpoints = endpoints.Select(e => new
            {
                e.AgentKey,
                e.Title,
                scopes = e.RequiredScopes ?? new List<string>(),
            })
        }));
    }

    public class CreateRequest
    {
        public string Name { get; set; } = string.Empty;
        public string? Description { get; set; }
        public List<string>? Scopes { get; set; }
        public int? TtlDays { get; set; }
    }

    /// <summary>
    /// 创建 Key。返回明文 —— 仅此一次，丢了只能重生成。
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateRequest req, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        if (string.IsNullOrWhiteSpace(req.Name))
            return BadRequest(ApiResponse<object>.Fail("INVALID_NAME", "Key 名称不能为空"));

        var scopes = (req.Scopes ?? new List<string>())
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim())
            .ToList();
        if (scopes.Count == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_SCOPES", "至少选择一个 scope（如 marketplace.skills:read）"));
        foreach (var s in scopes)
        {
            var (ok, reason) = await ValidateScopeAsync(s, ct);
            if (!ok) return BadRequest(ApiResponse<object>.Fail("INVALID_SCOPES", reason!));
        }

        var ttl = req.TtlDays is > 0 and <= MaxTtlDays ? req.TtlDays.Value : DefaultTtlDays;
        var (entity, plaintext) = await _keyService.CreateAsync(userId, req.Name, req.Description, scopes, ttl, ct);

        // 明文 Key 仅此处返回一次
        return Ok(ApiResponse<object>.Ok(new { item = ToDto(entity), apiKey = plaintext, warning = "这是 Key 唯一一次明文显示，请妥善保存。" }));
    }

    public class UpdateRequest
    {
        public string? Name { get; set; }
        public string? Description { get; set; }
        public List<string>? Scopes { get; set; }
        public bool? IsActive { get; set; }
    }

    [HttpPatch("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateRequest req, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var key = await _keyService.GetByIdAsync(id, ct);
        if (key == null || key.OwnerUserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "Key 不存在或无权访问"));

        if (req.Scopes != null)
        {
            var scopes = req.Scopes.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()).ToList();
            foreach (var s in scopes)
            {
                var (ok, reason) = await ValidateScopeAsync(s, ct);
                if (!ok) return BadRequest(ApiResponse<object>.Fail("INVALID_SCOPES", reason!));
            }
            req.Scopes = scopes;
        }

        await _keyService.UpdateMetadataAsync(id, req.Name, req.Description, req.Scopes, req.IsActive, ct);
        var reloaded = await _keyService.GetByIdAsync(id, ct);
        return Ok(ApiResponse<object>.Ok(new { item = reloaded == null ? null : ToDto(reloaded) }));
    }

    public class RenewRequest
    {
        public int? TtlDays { get; set; }
    }

    /// <summary>续期 —— 默认 +365 天，基于 max(当前时间, 原过期时间) 累加</summary>
    [HttpPost("{id}/renew")]
    public async Task<IActionResult> Renew(string id, [FromBody] RenewRequest? req, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var key = await _keyService.GetByIdAsync(id, ct);
        if (key == null || key.OwnerUserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "Key 不存在或无权访问"));

        var ttl = req?.TtlDays is > 0 and <= MaxTtlDays ? req.TtlDays!.Value : RenewTtlDays;
        await _keyService.RenewAsync(id, ttl, ct);
        var reloaded = await _keyService.GetByIdAsync(id, ct);
        return Ok(ApiResponse<object>.Ok(new { item = reloaded == null ? null : ToDto(reloaded) }));
    }

    /// <summary>撤销（立即失效，不可恢复）</summary>
    [HttpPost("{id}/revoke")]
    public async Task<IActionResult> Revoke(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var key = await _keyService.GetByIdAsync(id, ct);
        if (key == null || key.OwnerUserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "Key 不存在或无权访问"));

        await _keyService.RevokeAsync(id, ct);
        var reloaded = await _keyService.GetByIdAsync(id, ct);
        return Ok(ApiResponse<object>.Ok(new { item = reloaded == null ? null : ToDto(reloaded) }));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var key = await _keyService.GetByIdAsync(id, ct);
        if (key == null || key.OwnerUserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "Key 不存在或无权访问"));

        await _keyService.DeleteAsync(id, ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ======================================================================
    // Helpers
    // ======================================================================

    private static object ToDto(AgentApiKey k)
    {
        var now = DateTime.UtcNow;
        int? daysLeft = k.ExpiresAt.HasValue ? (int)Math.Ceiling((k.ExpiresAt.Value - now).TotalDays) : null;
        string status;
        if (k.RevokedAt.HasValue) status = "revoked";
        else if (!k.IsActive) status = "disabled";
        else if (k.ExpiresAt.HasValue && k.ExpiresAt.Value < now)
        {
            var graceEnd = k.ExpiresAt.Value.AddDays(k.GracePeriodDays);
            status = graceEnd < now ? "expired" : "grace";
        }
        else if (daysLeft is <= 30) status = "expiring-soon";
        else status = "active";

        return new
        {
            k.Id,
            k.Name,
            k.Description,
            keyPrefix = k.KeyPrefix,
            scopes = k.Scopes ?? new List<string>(),
            k.IsActive,
            k.CreatedAt,
            expiresAt = k.ExpiresAt,
            lastRenewedAt = k.LastRenewedAt,
            lastUsedAt = k.LastUsedAt,
            revokedAt = k.RevokedAt,
            totalRequests = k.TotalRequests,
            gracePeriodDays = k.GracePeriodDays,
            daysLeft,
            status
        };
    }
}
