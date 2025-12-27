using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Claims;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 阶段提示词管理（按阶段 stageKey + order + 角色 PM/DEV/QA）
/// </summary>
[ApiController]
[Route("api/v1/admin/prompt-stages")]
[Authorize(Roles = "ADMIN")]
public class AdminPromptStagesController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ICacheManager _cache;
    private readonly IPromptStageService _promptStageService;

    private static readonly TimeSpan IdempotencyExpiry = TimeSpan.FromMinutes(15);

    public AdminPromptStagesController(MongoDbContext db, ICacheManager cache, IPromptStageService promptStageService)
    {
        _db = db;
        _cache = cache;
        _promptStageService = promptStageService;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        // 用 raw 判断是否有覆盖（避免旧结构 POCO 映射丢字段导致误判）
        var overriddenRaw = await _db.PromptStagesRaw.Find(Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("_id", "global")).FirstOrDefaultAsync(ct);
        var effective = await _promptStageService.GetEffectiveSettingsAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            isOverridden = overriddenRaw != null
                           && overriddenRaw.TryGetValue("stages", out var s)
                           && s.IsBsonArray
                           && s.AsBsonArray.Count > 0,
            settings = effective
        }));
    }

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] UpsertPromptStagesRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"admin:promptstages:put:{adminId}:{idemKey}";
            var cached = await _cache.GetAsync<PromptStageSettings>(cacheKey);
            if (cached != null)
            {
                return Ok(ApiResponse<object>.Ok(new { settings = cached }));
            }
        }

        var stages = request?.Stages ?? new List<UpsertPromptStageItem>();
        if (stages.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "stages 不能为空"));

        var keys = new HashSet<string>(StringComparer.Ordinal);
        var ordersByRole = new Dictionary<UserRole, HashSet<int>>();
        foreach (var s in stages)
        {
            var stageKey = (s.StageKey ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(stageKey))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "stageKey 不能为空"));
            if (!keys.Add(stageKey))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "stageKey 不能重复"));

            if (s.Order <= 0)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "order 必须为正整数"));

            if (string.IsNullOrWhiteSpace(s.Role))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "role 不能为空"));
            if (!Enum.TryParse<UserRole>(s.Role.Trim(), ignoreCase: true, out var role) || role is UserRole.ADMIN)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "role 仅支持 PM/DEV/QA"));

            if (!ordersByRole.TryGetValue(role, out var set))
            {
                set = new HashSet<int>();
                ordersByRole[role] = set;
            }
            if (!set.Add(s.Order))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "同一 role 下 order 不能重复"));

            // title 建议必填（否则 UI 无法展示）；promptTemplate 允许为空（代表该阶段不注入提示词）
            if (string.IsNullOrWhiteSpace(s.Title))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "title 不能为空"));
        }

        // 统一保存：全量覆盖
        var doc = new PromptStageSettings
        {
            Id = "global",
            UpdatedAt = DateTime.UtcNow,
            Stages = stages
                .Select(x =>
                {
                    Enum.TryParse<UserRole>(x.Role.Trim(), ignoreCase: true, out var role);
                    return new PromptStageEntry
                    {
                        StageKey = x.StageKey.Trim(),
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

        await _db.PromptStages.ReplaceOneAsync(
            s => s.Id == "global",
            doc,
            new ReplaceOptions { IsUpsert = true },
            ct);

        await _promptStageService.RefreshAsync(ct);

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"admin:promptstages:put:{adminId}:{idemKey}";
            await _cache.SetAsync(cacheKey, doc, IdempotencyExpiry);
        }

        return Ok(ApiResponse<object>.Ok(new { settings = doc }));
    }

    [HttpPost("reset")]
    public async Task<IActionResult> Reset(CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].ToString() ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"admin:promptstages:reset:{adminId}:{idemKey}";
            var cached = await _cache.GetAsync<bool?>(cacheKey);
            if (cached == true)
            {
                return Ok(ApiResponse<object>.Ok(new { reset = true }));
            }
        }

        await _db.PromptStages.DeleteOneAsync(s => s.Id == "global", ct);
        await _promptStageService.RefreshAsync(ct);

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var cacheKey = $"admin:promptstages:reset:{adminId}:{idemKey}";
            await _cache.SetAsync(cacheKey, true, IdempotencyExpiry);
        }

        return Ok(ApiResponse<object>.Ok(new { reset = true }));
    }
}


