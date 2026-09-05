using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Controllers; // OpenApiController.ScopeCall（位于父命名空间，显式 using 让跨命名空间引用更清晰）
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Mcp;
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
///
/// 注：AI 无人值守自助签发曾试过在此挂 AiAccessKey 双方案，但「同请求同时带 JWT + 全局 key」
/// 时 FindFirst(sub) 会选错用户（Bugbot Medium）。已撤回。若需 AI 自助签发，应单独建只接受
/// AiAccessKey 的专用端点（无双身份歧义），见 debt.platform.md「MAP MCP 连接器」。
/// </summary>
[ApiController]
[Route("api/agent-api-keys")]
[Authorize]
public class AgentApiKeysController : ControllerBase
{
    // 固定 scope 白名单 = 接入台能力目录（视觉创作 / 文学创作 / 知识库 / 网页托管 / 海鲜市场）
    // 加上不属于任何能力卡的既有 scope。能力目录是 SSOT，这里不再手抄第二份清单。
    //
    // marketplace.skills:write 单列在这里：它没有任何 MCP 工具（上传走 multipart，MCP 传不了二进制），
    // 所以从能力卡上摘掉了；但市场上传的 REST 接口一直在用它，签发白名单不能跟着摘 —— 那会打断存量用法。
    private static readonly HashSet<string> FixedAllowedScopes = new HashSet<string>(
        McpCapabilityCatalog.AllScopes, StringComparer.OrdinalIgnoreCase)
    {
        MarketplaceSkillsOpenApiController.ScopeWrite,
        DefectAgentController.AgentFixScope,
        DefectAgentController.AgentShareScope,
        OpenApiController.ScopeCall,
    };

    // 默认 TTL：365 天（符合需求"授权时间尽可能长"）
    private const int DefaultTtlDays = 365;
    // 续期：每次 +365 天
    private const int RenewTtlDays = 365;
    // 用户端允许的最大 TTL：1095 天（3 年）；更长需管理员
    private const int MaxTtlDays = 1095;

    private readonly IAgentApiKeyService _keyService;
    private readonly MongoDbContext _db;
    private readonly IAdminPermissionService _permissions;

    public AgentApiKeysController(IAgentApiKeyService keyService, MongoDbContext db, IAdminPermissionService permissions)
    {
        _keyService = keyService;
        _db = db;
        _permissions = permissions;
    }

    /// <summary>
    /// 当前登录用户的有效权限位。签发密钥时用它跟请求的 scope 取交集 ——
    /// 没有这一步，任何人都能自己签一把带 `visual-agent:use` 的密钥，
    /// 绕过管理员分配的权限位（scope 在 AdminPermissionMiddleware 里是直接放行的）。
    /// </summary>
    private Task<IReadOnlyList<string>> OwnedPermissionsAsync(string userId, CancellationToken ct)
    {
        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);
        return _permissions.GetEffectivePermissionsAsync(userId, isRoot, ct);
    }

    /// <summary>
    /// 判断 scope 字符串是否被允许。两类：
    /// 1. FixedAllowedScopes 硬编码的核心 scope
    /// 2. AgentScopeFormat.Pattern 匹配的 agent.* scope，且该 scope 必须
    ///    已经被某条 AgentOpenEndpoint 登记过（防止用户创建"空头"scope）
    /// </summary>
    private async Task<(bool ok, string? reason)> ValidateScopeAsync(
        string scope, IReadOnlyList<string> ownedPermissions, CancellationToken ct)
    {
        // 受权限位把关的 scope：必须是用户自己就有的权限位，不能靠签发密钥凭空长出来。
        //
        // 查的是「签发口径」（IsIssuancePermissionChecked），比鉴权口径宽一档：
        //   - PermissionCheckedScopes：本轮新接的四个，签发查、鉴权也查
        //   - IssuanceOnlyPermissionCheckedScopes：document-store 两个，只在签发时查。
        //     它们等价于 document-store.read/.write 权限位（见 HasScopeGrant），谁能自签就等于
        //     自己长出了文档空间写权限；但存量密钥早就在跑，鉴权时才开始查会把它们当场打死，
        //     所以只收住「从现在起新签的」。
        // 不查整个能力目录：`marketplace.skills:read` 这类历史 scope 在权限目录里没有对应权限位
        //（它的闸门是 [RequireScope] 自己），拿它去查交集会把所有人——包括 root——挡在门外。
        if (McpCapabilityCatalog.IsIssuancePermissionChecked(scope))
        {
            if (!McpCapabilityCatalog.PermissionsAllowScope(ownedPermissions, scope))
            {
                var perm = McpCapabilityCatalog.ToPermission(scope);
                return (false, $"你自己还没有「{McpCapabilityCatalog.DescribePermission(perm)}」权限，不能把 `{scope}` 授权给智能体。请先找管理员开通。");
            }
            return (true, null);
        }
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

        /// <summary>
        /// `auto` = 能力范围跟着主人走，不存清单；其余（含缺省）= 按 Scopes 钉死。
        ///
        /// 缺省必须是 manual：密钥管理页那条老路径不传这个字段，语义一个字都不能变。
        /// </summary>
        public string? ScopeMode { get; set; }
    }

    /// <summary>
    /// 把请求里的 `auto` / `manual` 翻成枚举。认不出的一律按 manual ——
    /// 拼错一个字母就悄悄把范围放到最大，是最不该有的失败方向。
    /// </summary>
    private static AgentApiKeyScopeMode ParseScopeMode(string? raw)
        => string.Equals(raw, "auto", StringComparison.OrdinalIgnoreCase)
            ? AgentApiKeyScopeMode.Auto
            : AgentApiKeyScopeMode.Manual;

    /// <summary>
    /// 创建 Key。返回明文 —— 仅此一次，丢了只能重生成。
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateRequest req, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        if (string.IsNullOrWhiteSpace(req.Name))
            return BadRequest(ApiResponse<object>.Fail("INVALID_NAME", "Key 名称不能为空"));
        // 名字没有上限的话，它会顺着每一次调用被整个抄进审计行 —— 一把名字几 MB 的密钥
        // 等于给自己配了个放大器。审计那头也截，但源头收住才是根治。
        var nameTooLong = McpInputBounds.Text(req.Name, McpInputBounds.TitleBytes, "name");
        if (nameTooLong != null) return BadRequest(ApiResponse<object>.Fail("INVALID_NAME", nameTooLong));

        var scopeMode = ParseScopeMode(req.ScopeMode);
        var scopes = (req.Scopes ?? new List<string>())
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim())
            .ToList();

        // 自动模式不收清单，也就没什么可校验的：它每次鉴权现算「主人当前权限 ∩ 平台当前开放」，
        // 而这个交集本身就是签发校验要求的东西 —— 长不出主人没有的权限。
        // 传进来的 scopes 一律忽略，不留一份将来会漂的快照。
        if (scopeMode == AgentApiKeyScopeMode.Auto)
        {
            scopes = new List<string>();
        }
        else
        {
            if (scopes.Count == 0)
                return BadRequest(ApiResponse<object>.Fail("INVALID_SCOPES", "至少选择一个 scope（如 marketplace.skills:read）"));
            var ownedPermissions = await OwnedPermissionsAsync(userId, ct);
            foreach (var s in scopes)
            {
                var (ok, reason) = await ValidateScopeAsync(s, ownedPermissions, ct);
                if (!ok) return BadRequest(ApiResponse<object>.Fail("INVALID_SCOPES", reason!));
            }
        }

        var ttl = req.TtlDays is > 0 and <= MaxTtlDays ? req.TtlDays.Value : DefaultTtlDays;
        var (entity, plaintext) = await _keyService.CreateAsync(userId, req.Name, req.Description, scopes, ttl, ct, scopeMode);

        // 明文 Key 仅此处返回一次
        return Ok(ApiResponse<object>.Ok(new { item = ToDto(entity), apiKey = plaintext, warning = "这是 Key 唯一一次明文显示，请妥善保存。" }));
    }

    public class UpdateRequest
    {
        public string? Name { get; set; }
        public string? Description { get; set; }
        public List<string>? Scopes { get; set; }
        public bool? IsActive { get; set; }

        // 接入台（MCP）配额上限。null = 不改；配额触顶时的提示就是指这里，
        // 光有提示没有入口等于告诉用户一条走不通的路。
        public int? McpDailyImageQuota { get; set; }
        public int? McpDailyWriteQuota { get; set; }
        public int? McpRateLimitPerMin { get; set; }

        /// <summary>
        /// 显式切换能力范围模式。null = 不显式切，但**存了 scopes 就自动钉成 manual**
        /// （存清单那一刻就是「动过高级设置」那一刻）。
        /// </summary>
        public string? ScopeMode { get; set; }
    }

    [HttpPatch("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateRequest req, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var key = await _keyService.GetByIdAsync(id, ct);
        if (key == null || key.OwnerUserId != userId)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "Key 不存在或无权访问"));

        // 切回自动：清单作废（服务层会一并清空），也就没有 scope 要校验。
        // 顺序在 scope 校验之前 —— 否则「既传 scopeMode=auto 又带着一串旧 scope」的请求
        // 会拿一份马上要被丢掉的清单去撞校验，报一个用户根本无从理解的错。
        var explicitScopeMode = req.ScopeMode == null ? (AgentApiKeyScopeMode?)null : ParseScopeMode(req.ScopeMode);
        if (explicitScopeMode == AgentApiKeyScopeMode.Auto)
        {
            req.Scopes = null;
        }
        else if (req.Scopes != null)
        {
            var scopes = req.Scopes.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()).ToList();
            var ownedPermissions = await OwnedPermissionsAsync(userId, ct);
            foreach (var s in scopes)
            {
                var (ok, reason) = await ValidateScopeAsync(s, ownedPermissions, ct);
                if (!ok) return BadRequest(ApiResponse<object>.Fail("INVALID_SCOPES", reason!));
            }
            req.Scopes = scopes;
        }

        // 配额上限：给出的值必须落在合理区间，避免「调成 0 把自己锁死」或「调成天文数字等于没有闸门」。
        // 校验排在写库之前，且配额与元数据**合成同一次 Mongo 写**：
        // 分两次写的话，第二次失败会留下「接口报错了、但名字已经改了」的半截状态，
        // 用户照报错重试，状态和提示对不上。要么整笔生效，要么整笔不生效。
        var nameTooLong = McpInputBounds.Text(req.Name, McpInputBounds.TitleBytes, "name");
        if (nameTooLong != null) return BadRequest(ApiResponse<object>.Fail("INVALID_NAME", nameTooLong));

        if (req.McpDailyImageQuota is < 1 or > 500)
            return BadRequest(ApiResponse<object>.Fail("INVALID_QUOTA", "每日生图上限需在 1-500 之间"));
        if (req.McpDailyWriteQuota is < 1 or > 2000)
            return BadRequest(ApiResponse<object>.Fail("INVALID_QUOTA", "每日写入上限需在 1-2000 之间"));
        if (req.McpRateLimitPerMin is < 1 or > 600)
            return BadRequest(ApiResponse<object>.Fail("INVALID_QUOTA", "每分钟调用上限需在 1-600 之间"));

        await _keyService.UpdateMetadataAsync(
            id, req.Name, req.Description, req.Scopes, req.IsActive, ct,
            new AgentApiKeyQuotaPatch(req.McpDailyImageQuota, req.McpDailyWriteQuota, req.McpRateLimitPerMin),
            explicitScopeMode);

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
            // 能不能用走 AgentApiKey.IsUsableAt（与鉴权同一处判据），这里只负责把它翻成标签
            status = AgentApiKey.IsUsableAt(k, now, out _) ? "grace" : "expired";
        else if (daysLeft is <= 30) status = "expiring-soon";
        else status = "active";

        return new
        {
            k.Id,
            k.Name,
            k.Description,
            keyPrefix = k.KeyPrefix,
            scopes = k.Scopes ?? new List<string>(),
            scopeMode = k.ScopeMode == AgentApiKeyScopeMode.Auto ? "auto" : "manual",
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
