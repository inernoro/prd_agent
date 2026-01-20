using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Text.Json;
using System.Security.Claims;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 提示词管理（按 promptKey + order + 角色 PM/DEV/QA）
/// </summary>
[ApiController]
[Route("api/prompts")]
[Authorize]
[AdminController("prompts", AdminPermissionCatalog.SettingsRead, WritePermission = AdminPermissionCatalog.SettingsWrite)]
public class PromptsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IPromptService _promptService;

    public PromptsController(MongoDbContext db, IPromptService promptService)
    {
        _db = db;
        _promptService = promptService;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        // 按要求：任何情况下均回源 DB（PromptService 已禁用缓存）
        var effective = await _promptService.GetEffectiveSettingsAsync(ct);
        var defaults = await _promptService.GetDefaultSettingsAsync(ct);

        static string Normalize(string? s) => (s ?? string.Empty).Trim();

        static List<PromptEntry> NormalizePrompts(PromptSettings? settings)
        {
            var list = settings?.Prompts ?? new List<PromptEntry>();
            return list
                .Where(x => x.Role is UserRole.PM or UserRole.DEV or UserRole.QA)
                .Select(x => new PromptEntry
                {
                    Role = x.Role,
                    Order = x.Order,
                    PromptKey = Normalize(x.PromptKey),
                    Title = Normalize(x.Title),
                    PromptTemplate = Normalize(x.PromptTemplate)
                })
                .OrderBy(x => x.Role)
                .ThenBy(x => x.Order)
                .ToList();
        }

        static bool PromptsEqual(PromptSettings? a, PromptSettings? b)
        {
            var aa = NormalizePrompts(a);
            var bb = NormalizePrompts(b);
            if (aa.Count != bb.Count) return false;
            for (var i = 0; i < aa.Count; i++)
            {
                var x = aa[i];
                var y = bb[i];
                if (x.Role != y.Role) return false;
                if (x.Order != y.Order) return false;
                if (!string.Equals(x.PromptKey, y.PromptKey, StringComparison.Ordinal)) return false;
                if (!string.Equals(x.Title, y.Title, StringComparison.Ordinal)) return false;
                if (!string.Equals(x.PromptTemplate, y.PromptTemplate, StringComparison.Ordinal)) return false;
            }
            return true;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            // 新语义：只要与“系统内置默认阶段配置”不同，才算覆盖（即便 DB 中已被初始化为默认，也应视为“使用默认”）
            isOverridden = !PromptsEqual(effective, defaults),
            settings = effective
        }));
    }

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] UpsertPromptsRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cached = await _db.AdminIdempotencyRecords
                .Find(x => x.OwnerAdminId == adminId && x.Scope == "admin_prompts_put" && x.IdempotencyKey == idemKey)
                .FirstOrDefaultAsync(ct);
            if (cached != null && !string.IsNullOrWhiteSpace(cached.PayloadJson))
            {
                try
                {
                    var payload = JsonSerializer.Deserialize<JsonElement>(cached.PayloadJson);
                    return Ok(ApiResponse<object>.Ok(payload));
                }
                catch
                {
                    // ignore：幂等记录损坏时，降级为正常处理
                }
            }
        }

        var prompts = request?.Prompts ?? new List<UpsertPromptItem>();
        if (prompts.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "prompts 不能为空"));

        var keys = new HashSet<string>(StringComparer.Ordinal);
        var ordersByRole = new Dictionary<UserRole, HashSet<int>>();
        foreach (var p in prompts)
        {
            var promptKey = (p.PromptKey ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(promptKey))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "promptKey 不能为空"));
            if (!keys.Add(promptKey))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "promptKey 不能重复"));

            if (p.Order <= 0)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "order 必须为正整数"));

            if (string.IsNullOrWhiteSpace(p.Role))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "role 不能为空"));
            if (!Enum.TryParse<UserRole>(p.Role.Trim(), ignoreCase: true, out var role) || role is UserRole.ADMIN)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "role 仅支持 PM/DEV/QA"));

            if (!ordersByRole.TryGetValue(role, out var set))
            {
                set = new HashSet<int>();
                ordersByRole[role] = set;
            }
            if (!set.Add(p.Order))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "同一 role 下 order 不能重复"));

            // title 建议必填（否则 UI 无法展示）；promptTemplate 允许为空（代表该阶段不注入提示词）
            if (string.IsNullOrWhiteSpace(p.Title))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "title 不能为空"));
        }

        // 统一保存：全量覆盖
        var doc = new PromptSettings
        {
            Id = "global",
            UpdatedAt = DateTime.UtcNow,
            Prompts = prompts
                .Select(x =>
                {
                    Enum.TryParse<UserRole>(x.Role.Trim(), ignoreCase: true, out var role);
                    return new PromptEntry
                    {
                        PromptKey = x.PromptKey.Trim(),
                        Role = role,
                        Order = x.Order,
                        Title = x.Title.Trim(),
                        PromptTemplate = (x.PromptTemplate ?? string.Empty).Trim()
                    };
                })
                .OrderBy(x => x.Role)
                .ThenBy(x => x.Order)
                .ToList()
        };

        await _db.Prompts.ReplaceOneAsync(
            s => s.Id == "global",
            doc,
            new ReplaceOptions { IsUpsert = true },
            ct);

        await _promptService.RefreshAsync(ct);

        var payload2 = new { settings = doc };
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var rec = new AdminIdempotencyRecord
            {
                Id = Guid.NewGuid().ToString("N"),
                OwnerAdminId = adminId,
                Scope = "admin_prompts_put",
                IdempotencyKey = idemKey,
                PayloadJson = JsonSerializer.Serialize(payload2),
                CreatedAt = DateTime.UtcNow
            };
            try
            {
                await _db.AdminIdempotencyRecords.InsertOneAsync(rec, cancellationToken: ct);
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // ignore：并发写入同一 idemKey，保持幂等
            }
        }

        return Ok(ApiResponse<object>.Ok(payload2));
    }

    [HttpPost("reset")]
    public async Task<IActionResult> Reset(CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cached = await _db.AdminIdempotencyRecords
                .Find(x => x.OwnerAdminId == adminId && x.Scope == "admin_prompts_reset" && x.IdempotencyKey == idemKey)
                .FirstOrDefaultAsync(ct);
            if (cached != null && !string.IsNullOrWhiteSpace(cached.PayloadJson))
            {
                try
                {
                    var payload = JsonSerializer.Deserialize<JsonElement>(cached.PayloadJson);
                    return Ok(ApiResponse<object>.Ok(payload));
                }
                catch
                {
                    // ignore：幂等记录损坏时，降级为正常处理
                }
            }
        }

        await _db.Prompts.DeleteOneAsync(s => s.Id == "global", ct);
        await _promptService.RefreshAsync(ct);

        var payload2 = new { reset = true };
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var rec = new AdminIdempotencyRecord
            {
                Id = Guid.NewGuid().ToString("N"),
                OwnerAdminId = adminId,
                Scope = "admin_prompts_reset",
                IdempotencyKey = idemKey,
                PayloadJson = JsonSerializer.Serialize(payload2),
                CreatedAt = DateTime.UtcNow
            };
            try
            {
                await _db.AdminIdempotencyRecords.InsertOneAsync(rec, cancellationToken: ct);
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // ignore
            }
        }

        return Ok(ApiResponse<object>.Ok(payload2));
    }
}


