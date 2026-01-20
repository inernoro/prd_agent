using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Prompts.Templates;
using System.Security.Claims;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 提示词覆盖（将部分 system prompt 交还给用户可见可配）
/// </summary>
[ApiController]
[Route("api/prompts/overrides")]
[Authorize]
[AdminController("prompts", AdminPermissionCatalog.PromptsRead, WritePermission = AdminPermissionCatalog.PromptsWrite)]
public class PromptOverridesController : ControllerBase
{
    private readonly MongoDbContext _db;

    private const string KeyImageGenPlan = "imageGenPlan";
    private const int ImageGenPlanDefaultMaxItems = 10;
    private const int PromptMaxChars = 20_000;

    public PromptOverridesController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    private static string BuildDefaultImageGenPlanPrompt()
        => ImageGenPlanPrompt.Build(ImageGenPlanDefaultMaxItems);

    private static string Sha256Hex(string s)
    {
        var bytes = Encoding.UTF8.GetBytes(s ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    [HttpGet("image-gen-plan")]
    public async Task<IActionResult> GetImageGenPlan(CancellationToken ct)
    {
        var adminId = GetAdminId();
        var doc = await _db.AdminPromptOverrides
            .Find(x => x.OwnerAdminId == adminId && x.Key == KeyImageGenPlan)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);

        var defaultPromptText = BuildDefaultImageGenPlanPrompt();
        var overridden = doc != null && !string.IsNullOrWhiteSpace(doc.PromptText);

        return Ok(ApiResponse<object>.Ok(new
        {
            key = KeyImageGenPlan,
            isOverridden = overridden,
            promptText = overridden ? doc!.PromptText : defaultPromptText,
            defaultPromptText,
            updatedAt = overridden ? doc!.UpdatedAt : (DateTime?)null
        }));
    }

    [HttpPut("image-gen-plan")]
    public async Task<IActionResult> PutImageGenPlan([FromBody] UpsertPromptOverrideRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            // 幂等：不依赖唯一索引，按“最新一条”读取
            var cached = await _db.AdminIdempotencyRecords
                .Find(x => x.OwnerAdminId == adminId && x.Scope == "admin_promptoverrides_put_imageGenPlan" && x.IdempotencyKey == idemKey)
                .SortByDescending(x => x.CreatedAt)
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

        var promptText = (request?.PromptText ?? string.Empty).Trim();

        // 约定：空字符串视为“取消覆盖”（等价于 reset）
        if (string.IsNullOrWhiteSpace(promptText))
        {
            await _db.AdminPromptOverrides.DeleteOneAsync(x => x.OwnerAdminId == adminId && x.Key == KeyImageGenPlan, ct);
            var defaultPromptText = BuildDefaultImageGenPlanPrompt();
            var payload = new
            {
                key = KeyImageGenPlan,
                isOverridden = false,
                promptText = defaultPromptText,
                defaultPromptText,
                updatedAt = (DateTime?)null,
                reset = true
            };

            if (!string.IsNullOrWhiteSpace(idemKey))
            {
                var rec = new AdminIdempotencyRecord
                {
                    // 以确定性 Id 防并发重复（仅依赖 _id 唯一）
                    Id = Sha256Hex($"{adminId}|admin_promptoverrides_put_imageGenPlan|{idemKey}"),
                    OwnerAdminId = adminId,
                    Scope = "admin_promptoverrides_put_imageGenPlan",
                    IdempotencyKey = idemKey,
                    PayloadJson = JsonSerializer.Serialize(payload),
                    CreatedAt = DateTime.UtcNow
                };
                await _db.AdminIdempotencyRecords.ReplaceOneAsync(
                    x => x.Id == rec.Id,
                    rec,
                    new ReplaceOptions { IsUpsert = true },
                    ct);
            }

            return Ok(ApiResponse<object>.Ok(payload));
        }

        if (promptText.Length > PromptMaxChars)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"promptText 过长（最多 {PromptMaxChars} 字符）"));
        }

        var now = DateTime.UtcNow;
        // 不依赖 unique：使用确定性 Id（owner+key）写入，避免并发插入重复记录
        var overrideId = Sha256Hex($"{adminId}|{KeyImageGenPlan}");
        var doc2 = new AdminPromptOverride
        {
            Id = overrideId,
            OwnerAdminId = adminId,
            Key = KeyImageGenPlan,
            PromptText = promptText,
            UpdatedAt = now
        };
        await _db.AdminPromptOverrides.ReplaceOneAsync(
            x => x.Id == overrideId,
            doc2,
            new ReplaceOptions { IsUpsert = true },
            ct);

        var defaultPrompt = BuildDefaultImageGenPlanPrompt();
        var payload2 = new
        {
            key = KeyImageGenPlan,
            isOverridden = true,
            promptText,
            defaultPromptText = defaultPrompt,
            updatedAt = now
        };

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var rec = new AdminIdempotencyRecord
            {
                Id = Sha256Hex($"{adminId}|admin_promptoverrides_put_imageGenPlan|{idemKey}"),
                OwnerAdminId = adminId,
                Scope = "admin_promptoverrides_put_imageGenPlan",
                IdempotencyKey = idemKey,
                PayloadJson = JsonSerializer.Serialize(payload2),
                CreatedAt = DateTime.UtcNow
            };
            await _db.AdminIdempotencyRecords.ReplaceOneAsync(
                x => x.Id == rec.Id,
                rec,
                new ReplaceOptions { IsUpsert = true },
                ct);
        }

        return Ok(ApiResponse<object>.Ok(payload2));
    }

    [HttpDelete("image-gen-plan")]
    public async Task<IActionResult> DeleteImageGenPlan(CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cached = await _db.AdminIdempotencyRecords
                .Find(x => x.OwnerAdminId == adminId && x.Scope == "admin_promptoverrides_del_imageGenPlan" && x.IdempotencyKey == idemKey)
                .SortByDescending(x => x.CreatedAt)
                .FirstOrDefaultAsync(ct);
            if (cached != null && !string.IsNullOrWhiteSpace(cached.PayloadJson))
            {
                try
                {
                    var cachedPayload = JsonSerializer.Deserialize<JsonElement>(cached.PayloadJson);
                    return Ok(ApiResponse<object>.Ok(cachedPayload));
                }
                catch
                {
                    // ignore
                }
            }
        }

        await _db.AdminPromptOverrides.DeleteOneAsync(x => x.OwnerAdminId == adminId && x.Key == KeyImageGenPlan, ct);

        var defaultPromptText = BuildDefaultImageGenPlanPrompt();
        var payload = new
        {
            key = KeyImageGenPlan,
            isOverridden = false,
            promptText = defaultPromptText,
            defaultPromptText,
            updatedAt = (DateTime?)null,
            reset = true
        };

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var rec = new AdminIdempotencyRecord
            {
                Id = Sha256Hex($"{adminId}|admin_promptoverrides_del_imageGenPlan|{idemKey}"),
                OwnerAdminId = adminId,
                Scope = "admin_promptoverrides_del_imageGenPlan",
                IdempotencyKey = idemKey,
                PayloadJson = JsonSerializer.Serialize(payload),
                CreatedAt = DateTime.UtcNow
            };
            await _db.AdminIdempotencyRecords.ReplaceOneAsync(
                x => x.Id == rec.Id,
                rec,
                new ReplaceOptions { IsUpsert = true },
                ct);
        }

        return Ok(ApiResponse<object>.Ok(payload));
    }
}

public class UpsertPromptOverrideRequest
{
    public string? PromptText { get; set; }
}


