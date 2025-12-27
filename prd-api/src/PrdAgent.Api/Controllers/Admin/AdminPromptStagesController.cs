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
        var overridden = await _db.PromptStages.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
        var effective = await _promptStageService.GetEffectiveSettingsAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            isOverridden = overridden != null && overridden.Stages.Count > 0,
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
        var orders = new HashSet<int>();
        foreach (var s in stages)
        {
            var order = s.Order;
            var step = s.Step;
            if (order <= 0 && step.HasValue && step.Value > 0) order = step.Value;
            if (order <= 0)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "order 必须为正整数（或提供 step 兼容字段）"));
            if (!orders.Add(order))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "order 不能重复"));

            var stageKey = (s.StageKey ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(stageKey))
            {
                // 兼容旧请求：未传 stageKey 时，按 step/order 生成稳定 key
                stageKey = $"legacy-step-{(step ?? order)}";
            }
            if (!keys.Add(stageKey))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "stageKey 不能重复"));

            static bool ValidRole(RoleStagePrompt r)
                => r != null
                   && !string.IsNullOrWhiteSpace(r.Title)
                   && !string.IsNullOrWhiteSpace(r.PromptTemplate);

            if (!ValidRole(s.Pm) || !ValidRole(s.Dev) || !ValidRole(s.Qa))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "每个阶段的 pm/dev/qa 的 title 与 promptTemplate 均不能为空"));
        }

        // 统一保存：全量覆盖
        var doc = new PromptStageSettings
        {
            Id = "global",
            UpdatedAt = DateTime.UtcNow,
            Stages = stages
                .Select(x =>
                {
                    var order = x.Order;
                    var step = x.Step;
                    if (order <= 0 && step.HasValue && step.Value > 0) order = step.Value;
                    var stageKey = (x.StageKey ?? string.Empty).Trim();
                    if (string.IsNullOrWhiteSpace(stageKey))
                        stageKey = $"legacy-step-{(step ?? order)}";
                    return new PromptStage
                    {
                        StageKey = stageKey,
                        Order = order,
                        Step = step ?? order,
                        Pm = new RoleStagePrompt { Title = x.Pm.Title.Trim(), PromptTemplate = x.Pm.PromptTemplate.Trim() },
                        Dev = new RoleStagePrompt { Title = x.Dev.Title.Trim(), PromptTemplate = x.Dev.PromptTemplate.Trim() },
                        Qa = new RoleStagePrompt { Title = x.Qa.Title.Trim(), PromptTemplate = x.Qa.PromptTemplate.Trim() },
                    };
                })
                .OrderBy(x => x.Order)
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


