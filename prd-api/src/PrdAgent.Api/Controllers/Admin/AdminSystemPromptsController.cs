using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - PRD 问答系统提示词（非 JSON 输出任务）
/// - 按角色（PM/DEV/QA）分别配置
/// </summary>
[ApiController]
[Route("api/v1/admin/system-prompts")]
[Authorize]
[AdminController("admin-prompts", AdminPermissionCatalog.SettingsRead, WritePermission = AdminPermissionCatalog.SettingsWrite)]
public class AdminSystemPromptsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ISystemPromptService _systemPromptService;

    public AdminSystemPromptsController(MongoDbContext db, ISystemPromptService systemPromptService)
    {
        _db = db;
        _systemPromptService = systemPromptService;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var effective = await _systemPromptService.GetEffectiveSettingsAsync(ct);
        var defaults = await _systemPromptService.GetDefaultSettingsAsync(ct);

        static string Normalize(string? s) => (s ?? string.Empty).Trim();

        static List<SystemPromptEntry> NormalizeEntries(SystemPromptSettings? s)
        {
            var list = s?.Entries ?? new List<SystemPromptEntry>();
            return list
                .Where(x => x.Role is UserRole.PM or UserRole.DEV or UserRole.QA)
                .Select(x => new SystemPromptEntry
                {
                    Role = x.Role,
                    SystemPrompt = Normalize(x.SystemPrompt)
                })
                .OrderBy(x => x.Role)
                .ToList();
        }

        static bool EntriesEqual(SystemPromptSettings? a, SystemPromptSettings? b)
        {
            var aa = NormalizeEntries(a);
            var bb = NormalizeEntries(b);
            if (aa.Count != bb.Count) return false;
            for (var i = 0; i < aa.Count; i++)
            {
                if (aa[i].Role != bb[i].Role) return false;
                if (!string.Equals(aa[i].SystemPrompt, bb[i].SystemPrompt, StringComparison.Ordinal)) return false;
            }
            return true;
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            isOverridden = !EntriesEqual(effective, defaults),
            settings = effective
        }));
    }

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] UpsertSystemPromptsRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cached = await _db.AdminIdempotencyRecords
                .Find(x => x.OwnerAdminId == adminId && x.Scope == "admin_system_prompts_put" && x.IdempotencyKey == idemKey)
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

        var entries = request?.Entries ?? new List<UpsertSystemPromptItem>();
        if (entries.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "entries 不能为空"));

        var roleSet = new HashSet<UserRole>();
        foreach (var it in entries)
        {
            var roleRaw = (it.Role ?? string.Empty).Trim();
            if (!Enum.TryParse<UserRole>(roleRaw, ignoreCase: true, out var role) || role is UserRole.ADMIN)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "role 仅支持 PM/DEV/QA"));

            if (!roleSet.Add(role))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "role 不能重复"));

            var sp = (it.SystemPrompt ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(sp))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "systemPrompt 不能为空"));
            if (sp.Length > 20000)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "systemPrompt 过长（上限 20000 字符）"));

            // 防误配：禁止“只返回 JSON / JSON schema”类强制约束出现在 PRD 问答 system prompt 中
            var lower = sp.ToLowerInvariant();
            if (lower.Contains("只返回json", StringComparison.OrdinalIgnoreCase) ||
                lower.Contains("only return json", StringComparison.OrdinalIgnoreCase) ||
                lower.Contains("json schema", StringComparison.OrdinalIgnoreCase) ||
                lower.Contains("```json", StringComparison.OrdinalIgnoreCase))
            {
                return BadRequest(ApiResponse<object>.Fail(
                    ErrorCodes.INVALID_FORMAT,
                    "systemPrompt 包含 JSON 输出强制约束（不允许在 PRD 问答 system prompt 中配置）。"));
            }
        }

        var doc = new SystemPromptSettings
        {
            Id = "global",
            UpdatedAt = DateTime.UtcNow,
            Entries = entries
                .Select(x =>
                {
                    Enum.TryParse<UserRole>((x.Role ?? string.Empty).Trim(), ignoreCase: true, out var role);
                    return new SystemPromptEntry
                    {
                        Role = role,
                        SystemPrompt = (x.SystemPrompt ?? string.Empty).Trim()
                    };
                })
                .Where(x => x.Role is UserRole.PM or UserRole.DEV or UserRole.QA)
                .OrderBy(x => x.Role)
                .ToList()
        };

        await _db.SystemPrompts.ReplaceOneAsync(
            s => s.Id == "global",
            doc,
            new ReplaceOptions { IsUpsert = true },
            ct);

        await _systemPromptService.RefreshAsync(ct);

        var payload2 = new { settings = doc };
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var rec = new AdminIdempotencyRecord
            {
                Id = Guid.NewGuid().ToString("N"),
                OwnerAdminId = adminId,
                Scope = "admin_system_prompts_put",
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
                .Find(x => x.OwnerAdminId == adminId && x.Scope == "admin_system_prompts_reset" && x.IdempotencyKey == idemKey)
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
                    // ignore
                }
            }
        }

        await _db.SystemPrompts.DeleteOneAsync(s => s.Id == "global", ct);
        await _systemPromptService.RefreshAsync(ct);

        var payload2 = new { reset = true };
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var rec = new AdminIdempotencyRecord
            {
                Id = Guid.NewGuid().ToString("N"),
                OwnerAdminId = adminId,
                Scope = "admin_system_prompts_reset",
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


