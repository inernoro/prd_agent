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
    private readonly PrdAgent.Infrastructure.LlmGateway.ILlmGateway _gateway;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<ResolverDebugController> _logger;

    public ResolverDebugController(
        MongoDbContext db,
        IModelResolver resolver,
        PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
        IServiceScopeFactory scopeFactory,
        ILogger<ResolverDebugController> logger)
    {
        _db = db;
        _resolver = resolver;
        _gateway = gateway;
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    /// <summary>
    /// 模拟 Worker 真实路径：用 _scopeFactory.CreateScope() 创建新 scope（而不是当前 HTTP 请求 scope），
    /// 在新 scope 里解析 ILlmGateway，调用两次 ResolveModelAsync，对比 instance hash 和结果。
    /// 目的：验证 test-chain 在 HTTP scope 里正常但真实 Worker 路径里的 LLM 日志仍然错误之谜。
    /// </summary>
    [HttpPost("simulate-worker")]
    public async Task<IActionResult> SimulateWorker(
        [FromBody] ResolverTestRequest body,
        CancellationToken ct)
    {
        var code = (body?.AppCallerCode ?? string.Empty).Trim();
        var type = string.IsNullOrWhiteSpace(body?.ModelType) ? "generation" : body.ModelType.Trim();
        var expected = string.IsNullOrWhiteSpace(body?.ExpectedModel) ? null : body.ExpectedModel.Trim();

        _logger.LogWarning("[SimulateWorker] === Creating new scope via _scopeFactory.CreateScope() ===");

        // 和 ImageGenRunWorker Line 224 一样的调用方式
        using var scope = _scopeFactory.CreateScope();
        var gatewayInScope = scope.ServiceProvider.GetRequiredService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
        var resolverInScope = scope.ServiceProvider.GetRequiredService<IModelResolver>();

        var resolverHash = resolverInScope.GetHashCode().ToString("X");
        var gatewayHash = gatewayInScope.GetHashCode().ToString("X");

        _logger.LogWarning("[SimulateWorker] resolver hash in new scope: {RH}, gateway hash: {GH}", resolverHash, gatewayHash);

        // 第 1 次：通过 gateway.ResolveModelAsync（和 OpenAIImageClient line 165 一样）
        var r1 = await gatewayInScope.ResolveModelAsync(code, type, expected, ct);

        // 第 2 次：通过 IModelResolver 直接（和 LlmGateway.SendRawAsync line 561 一样传 null）
        var r2 = await resolverInScope.ResolveAsync(code, type, null, ct);

        return Ok(new
        {
            note = "模拟 Worker 使用 _scopeFactory.CreateScope() 新建 scope",
            resolverInstanceHashInNewScope = resolverHash,
            gatewayInstanceHashInNewScope = gatewayHash,
            call1_via_gateway = new
            {
                actualModel = r1.ActualModel,
                modelGroupName = r1.ModelGroupName,
                success = r1.Success,
            },
            call2_via_resolver_null = new
            {
                actualModel = r2.ActualModel,
                modelGroupName = r2.ModelGroupName,
                resolutionType = r2.ResolutionType,
                success = r2.Success,
            },
            sameModelBothCalls = r1.ActualModel == r2.ActualModel,
            verdict = r1.ActualModel == r2.ActualModel
                ? "在 _scopeFactory 新建的 scope 里也正常"
                : $"在 _scopeFactory 新建的 scope 里失效！call1={r1.ActualModel} call2={r2.ActualModel} — 这就是 Worker 实际路径的问题"
        });
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
    /// 双调用测试：在**同一 async 链中**依次调用 IModelResolver.ResolveAsync 两次 —
    /// 第 1 次带 expectedModel（模拟 OpenAIImageClient 入口），第 2 次传 null
    /// （模拟 LlmGateway.SendRawAsync 内部的硬编码 null 调用）。
    /// 如果装饰器的 AsyncLocal 生效，第 2 次应该自动恢复 expectedModel 并返回同样的 actualModel。
    /// </summary>
    [HttpPost("test-chain")]
    public async Task<IActionResult> TestChain(
        [FromBody] ResolverTestRequest body,
        CancellationToken ct)
    {
        var code = (body?.AppCallerCode ?? string.Empty).Trim();
        var type = string.IsNullOrWhiteSpace(body?.ModelType) ? "generation" : body.ModelType.Trim();
        var expected = string.IsNullOrWhiteSpace(body?.ExpectedModel) ? null : body.ExpectedModel.Trim();
        if (string.IsNullOrWhiteSpace(code)) return BadRequest(new { error = "appCallerCode 不能为空" });

        _logger.LogWarning("[TestChain] === START === code={Code} expected='{Expected}'", code, expected ?? "(null)");

        // 第 1 次：带 expectedModel（模拟 OpenAIImageClient.GenerateAsync 入口）
        ModelResolutionResult? r1 = null;
        string? err1 = null;
        try { r1 = await _resolver.ResolveAsync(code, type, expected, ct); }
        catch (Exception ex) { err1 = ex.Message; }

        // 第 2 次：expectedModel=null（模拟 LlmGateway.SendRawAsync 内部）
        // 重要：同一 async method 内，AsyncLocal 应该保留第 1 次的值
        ModelResolutionResult? r2 = null;
        string? err2 = null;
        try { r2 = await _resolver.ResolveAsync(code, type, null, ct); }
        catch (Exception ex) { err2 = ex.Message; }

        _logger.LogWarning(
            "[TestChain] === END === call1(expected={E1}) → actual={A1} pool={P1} | call2(null) → actual={A2} pool={P2}",
            expected ?? "(null)",
            r1?.ActualModel ?? "(null)",
            r1?.ModelGroupName ?? "(null)",
            r2?.ActualModel ?? "(null)",
            r2?.ModelGroupName ?? "(null)");

        return Ok(new
        {
            input = new { appCallerCode = code, modelType = type, expectedModel = expected },
            call1_with_expected = new
            {
                error = err1,
                actualModel = r1?.ActualModel,
                modelGroupName = r1?.ModelGroupName,
                resolutionType = r1?.ResolutionType,
                success = r1?.Success,
            },
            call2_with_null = new
            {
                error = err2,
                actualModel = r2?.ActualModel,
                modelGroupName = r2?.ModelGroupName,
                resolutionType = r2?.ResolutionType,
                success = r2?.Success,
            },
            asyncLocalWorks = r1?.ActualModel == r2?.ActualModel,
            verdict = r1?.ActualModel == r2?.ActualModel
                ? "AsyncLocal WORKS — SendRawAsync 内部 null 调用会得到正确 model"
                : $"AsyncLocal BROKEN — call1={r1?.ActualModel} call2={r2?.ActualModel}（这就是实际生图时 SendRawAsync 覆盖上游 model 的原因）"
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
