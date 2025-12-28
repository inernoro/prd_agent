using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Prompts.Templates;
using System.Security.Claims;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 提示词覆盖（将部分 system prompt 交还给用户可见可配）
/// </summary>
[ApiController]
[Route("api/v1/admin/prompt-overrides")]
[Authorize(Roles = "ADMIN")]
public class AdminPromptOverridesController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ICacheManager _cache;

    private static readonly TimeSpan IdempotencyExpiry = TimeSpan.FromMinutes(15);

    private const string KeyImageGenPlan = "imageGenPlan";
    private const int ImageGenPlanDefaultMaxItems = 10;
    private const int PromptMaxChars = 20_000;

    public AdminPromptOverridesController(MongoDbContext db, ICacheManager cache)
    {
        _db = db;
        _cache = cache;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    private static string BuildDefaultImageGenPlanPrompt()
        => ImageGenPlanPrompt.Build(ImageGenPlanDefaultMaxItems);

    [HttpGet("image-gen-plan")]
    public async Task<IActionResult> GetImageGenPlan(CancellationToken ct)
    {
        var adminId = GetAdminId();
        var doc = await _db.AdminPromptOverrides
            .Find(x => x.OwnerAdminId == adminId && x.Key == KeyImageGenPlan)
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
            var cacheKey = $"admin:promptoverrides:put:{adminId}:{KeyImageGenPlan}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null)
            {
                return Ok(ApiResponse<object>.Ok(cached));
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
                var cacheKey = $"admin:promptoverrides:put:{adminId}:{KeyImageGenPlan}:{idemKey}";
                await _cache.SetAsync(cacheKey, payload, IdempotencyExpiry);
            }

            return Ok(ApiResponse<object>.Ok(payload));
        }

        if (promptText.Length > PromptMaxChars)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"promptText 过长（最多 {PromptMaxChars} 字符）"));
        }

        var now = DateTime.UtcNow;
        var filter = Builders<AdminPromptOverride>.Filter.Eq(x => x.OwnerAdminId, adminId)
                     & Builders<AdminPromptOverride>.Filter.Eq(x => x.Key, KeyImageGenPlan);
        var update = Builders<AdminPromptOverride>.Update
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
            .Set(x => x.OwnerAdminId, adminId)
            .Set(x => x.Key, KeyImageGenPlan)
            .Set(x => x.PromptText, promptText)
            .Set(x => x.UpdatedAt, now);
        await _db.AdminPromptOverrides.UpdateOneAsync(filter, update, new UpdateOptions { IsUpsert = true }, ct);

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
            var cacheKey = $"admin:promptoverrides:put:{adminId}:{KeyImageGenPlan}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload2, IdempotencyExpiry);
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
            var cacheKey = $"admin:promptoverrides:del:{adminId}:{KeyImageGenPlan}:{idemKey}";
            var cached = await _cache.GetAsync<object>(cacheKey);
            if (cached != null)
            {
                return Ok(ApiResponse<object>.Ok(cached));
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
            var cacheKey = $"admin:promptoverrides:del:{adminId}:{KeyImageGenPlan}:{idemKey}";
            await _cache.SetAsync(cacheKey, payload, IdempotencyExpiry);
        }

        return Ok(ApiResponse<object>.Ok(payload));
    }
}

public class UpsertPromptOverrideRequest
{
    public string? PromptText { get; set; }
}


