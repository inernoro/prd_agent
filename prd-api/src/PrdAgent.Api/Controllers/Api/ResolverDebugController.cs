using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 模型调度调试端点 —— 不跑生图、直接暴露 Tier 匹配算法。
///
/// 目的：让"选 A 给 B"问题可以独立测试，避免每次都触发真实生图。
/// 所有返回都是 JSON，前端/Postman/curl 都能直接调。
///
/// 路径：
///   POST /api/debug/resolver/test
///   GET  /api/debug/resolver/inspect?appCallerCode=xxx&modelType=xxx
///
/// ⚠ 本接口仅供调试，正式上线前应改为管理员专属权限（目前用 [AllowAnonymous]
/// 以便跨浏览器快速 curl；上线前收紧）。
/// </summary>
[ApiController]
[Route("api/debug/resolver")]
public class ResolverDebugController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IModelResolver _resolver;
    private readonly ILogger<ResolverDebugController> _logger;

    public ResolverDebugController(
        MongoDbContext db,
        IModelResolver resolver,
        ILogger<ResolverDebugController> logger)
    {
        _db = db;
        _resolver = resolver;
        _logger = logger;
    }

    /// <summary>
    /// 完整的匹配算法测试：走当前注册的 IModelResolver（包含装饰器），并返回
    /// 候选池状态 + 每档匹配细节 + 最终解析结果。
    /// </summary>
    [HttpPost("test")]
    public async Task<IActionResult> Test(
        [FromBody] ResolverTestRequest body,
        CancellationToken ct)
    {
        var code = (body?.AppCallerCode ?? string.Empty).Trim();
        var type = string.IsNullOrWhiteSpace(body?.ModelType) ? "generation" : body.ModelType.Trim();
        var expected = string.IsNullOrWhiteSpace(body?.ExpectedModel) ? null : body.ExpectedModel.Trim();

        if (string.IsNullOrWhiteSpace(code))
            return BadRequest(new { error = "appCallerCode 不能为空" });

        _logger.LogInformation(
            "[ResolverDebug] Test 请求: code={Code} type={Type} expected='{Expected}'",
            code, type, expected ?? "(null)");

        // 1. 读 AppCaller
        var appCaller = await _db.LLMAppCallers
            .Find(a => a.AppCode == code)
            .FirstOrDefaultAsync(ct);
        var requirement = appCaller?.ModelRequirements.FirstOrDefault(r => r.ModelType == type);

        // 2. 读候选池
        var groups = new List<ModelGroup>();
        if (requirement?.ModelGroupIds != null && requirement.ModelGroupIds.Count > 0)
        {
            groups = await _db.ModelGroups
                .Find(g => requirement.ModelGroupIds.Contains(g.Id))
                .SortBy(g => g.Priority)
                .ToListAsync(ct);
        }

        // 3. 独立跑一遍 Tier1/2/3（和装饰器同一套逻辑，用于返回 step-by-step 诊断）
        var steps = new List<object>();
        SimulateMatch(groups, expected, steps);

        // 4. 再通过真实 IModelResolver 调用，拿到实际返回
        ModelResolutionResult? actual = null;
        string? actualError = null;
        try
        {
            actual = await _resolver.ResolveAsync(code, type, expected, ct);
        }
        catch (Exception ex)
        {
            actualError = ex.Message;
        }

        return Ok(new
        {
            input = new { appCallerCode = code, modelType = type, expectedModel = expected },
            appCallerFound = appCaller != null,
            bound = requirement != null,
            candidatePools = groups.Select(g => new
            {
                id = g.Id,
                name = g.Name,
                code = g.Code,
                priority = g.Priority,
                models = g.Models?.Select(m => new
                {
                    modelId = m.ModelId,
                    platformId = m.PlatformId,
                    health = m.HealthStatus.ToString(),
                    priority = m.Priority
                }).ToArray()
            }).ToArray(),
            matchingTrace = steps,
            liveResolverOutput = actual == null ? null : new
            {
                success = actual.Success,
                resolutionType = actual.ResolutionType,
                expectedModel = actual.ExpectedModel,
                actualModel = actual.ActualModel,
                actualPlatformId = actual.ActualPlatformId,
                actualPlatformName = actual.ActualPlatformName,
                modelGroupId = actual.ModelGroupId,
                modelGroupName = actual.ModelGroupName,
                apiUrl = actual.ApiUrl,
                errorMessage = actual.ErrorMessage
            },
            liveResolverError = actualError,
        });
    }

    /// <summary>
    /// 只读探查：列出 AppCaller 及其绑定池的完整信息（供前端 debug 面板查看）。
    /// </summary>
    [HttpGet("inspect")]
    public async Task<IActionResult> Inspect(
        [FromQuery] string appCallerCode,
        [FromQuery] string modelType = "generation",
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(appCallerCode))
            return BadRequest(new { error = "appCallerCode required" });

        var code = appCallerCode.Trim();
        var appCaller = await _db.LLMAppCallers
            .Find(a => a.AppCode == code)
            .FirstOrDefaultAsync(ct);

        if (appCaller == null)
            return Ok(new { appCallerCode = code, found = false });

        var req = appCaller.ModelRequirements.FirstOrDefault(r => r.ModelType == modelType);
        var groups = new List<ModelGroup>();
        if (req?.ModelGroupIds != null && req.ModelGroupIds.Count > 0)
        {
            groups = await _db.ModelGroups
                .Find(g => req.ModelGroupIds.Contains(g.Id))
                .SortBy(g => g.Priority)
                .ToListAsync(ct);
        }

        return Ok(new
        {
            appCallerCode = code,
            found = true,
            modelType,
            modelGroupIds = req?.ModelGroupIds ?? new List<string>(),
            pools = groups.Select(g => new
            {
                id = g.Id,
                name = g.Name,
                code = g.Code,
                priority = g.Priority,
                modelType = g.ModelType,
                isDefaultForType = g.IsDefaultForType,
                models = g.Models?.Select(m => new
                {
                    modelId = m.ModelId,
                    platformId = m.PlatformId,
                    health = m.HealthStatus.ToString(),
                    healthInt = (int)m.HealthStatus,
                    priority = m.Priority
                }).ToArray()
            })
        });
    }

    private static void SimulateMatch(List<ModelGroup> groups, string? expected, List<object> steps)
    {
        if (string.IsNullOrWhiteSpace(expected))
        {
            steps.Add(new { tier = 0, note = "expectedModel 为空 → 跳过匹配", result = "skip" });
            return;
        }

        // Tier 1: ModelId 精确
        foreach (var g in groups)
        {
            if (g.Models == null) continue;
            foreach (var m in g.Models)
            {
                var healthy = m.HealthStatus != ModelHealthStatus.Unavailable;
                var hit = string.Equals(m.ModelId, expected, StringComparison.OrdinalIgnoreCase);
                if (hit && healthy)
                {
                    steps.Add(new { tier = 1, status = "HIT", pool = g.Name, modelId = m.ModelId, reason = "ModelId 精确" });
                    return;
                }
            }
        }
        steps.Add(new { tier = 1, status = "miss", reason = "无 ModelId 精确匹配" });

        // Tier 2: 前缀
        foreach (var g in groups)
        {
            if (g.Models == null) continue;
            foreach (var m in g.Models)
            {
                var healthy = m.HealthStatus != ModelHealthStatus.Unavailable;
                var pref = !string.IsNullOrEmpty(m.ModelId) && m.ModelId.StartsWith(expected, StringComparison.OrdinalIgnoreCase);
                if (pref && healthy)
                {
                    steps.Add(new { tier = 2, status = "HIT", pool = g.Name, modelId = m.ModelId, reason = $"'{m.ModelId}' starts with '{expected}'" });
                    return;
                }
            }
        }
        steps.Add(new { tier = 2, status = "miss", reason = "无 ModelId 前缀匹配" });

        // Tier 3: 池名 / 池 Code
        foreach (var g in groups)
        {
            if (g.Models == null || g.Models.Count == 0) continue;
            var byName = string.Equals(g.Name, expected, StringComparison.OrdinalIgnoreCase);
            var byCode = string.Equals(g.Code, expected, StringComparison.OrdinalIgnoreCase);
            if (!byName && !byCode) continue;

            var picked =
                g.Models.FirstOrDefault(m => m.HealthStatus == ModelHealthStatus.Healthy)
                ?? g.Models.FirstOrDefault(m => m.HealthStatus == ModelHealthStatus.Degraded);
            if (picked != null)
            {
                steps.Add(new { tier = 3, status = "HIT", pool = g.Name, modelId = picked.ModelId, reason = byCode ? "池 Code 精确" : "池 Name 精确" });
                return;
            }

            steps.Add(new { tier = 3, status = "pool matched but no healthy model", pool = g.Name });
        }
        steps.Add(new { tier = 3, status = "miss", reason = "池名/Code 均未匹配 expectedModel" });

        steps.Add(new { final = "ALL_MISS", note = "将委派给内部 resolver（可能跑老代码）" });
    }

    public class ResolverTestRequest
    {
        public string? AppCallerCode { get; set; }
        public string? ModelType { get; set; }
        public string? ExpectedModel { get; set; }
    }
}
