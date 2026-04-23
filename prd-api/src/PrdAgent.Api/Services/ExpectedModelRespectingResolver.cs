using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>
/// IModelResolver 装饰器（Api.dll 层）—— 绕过 Infrastructure.dll 部署缓存 bug。
///
/// 背景：Round 1-5 修复在 ModelResolver.FindPreferredModel 中加了"尊重 expectedModel"的
/// 匹配逻辑，但 CDS 部署层对 Infrastructure.dll 的改动缓存了老版本（publish 成功但 dotnet
/// 进程加载的是老 DLL）。数小时的诊断确认 Api.dll 能正常部署，Infrastructure.dll 不能。
///
/// 本装饰器在 Api.dll 里实现完整的 expectedModel 匹配（Tier1/2/3），拦截所有 ResolveAsync
/// 调用。命中则直接返回 FromPool；未命中才委派给内部的 ModelResolver（可能是老版本）。
///
/// 待 CDS 部署 bug 解决后本装饰器可撤回。
/// </summary>
public class ExpectedModelRespectingResolver : IModelResolver
{
    // 同一 DI scope 内缓存 expectedModel —— 解决 LlmGateway.SendRawAsync 内部二次调用
    // ResolveAsync 时 expectedModel 被硬编码成 null 的问题。
    //
    // 为什么是 instance field 而不是 AsyncLocal：
    //   - AsyncLocal 从"被调用方"写入，值不会 flow 回"调用方"后续调用（ExecutionContext capture 是
    //     在 await 之前拍快照的）。实测 test-chain 里 call1 写入的值 call2 读不到。
    //   - 装饰器注册为 Scoped，同一个 scope（同一次 HTTP 请求 / 同一次 Worker run）里 DI 给出的
    //     是同一个实例。所以实例字段能跨 OpenAIImageClient.GenerateAsync 和 LlmGateway.SendRawAsync
    //     两次 ResolveAsync 调用自然传递。
    //   - 并发安全：Scoped 每个请求独立实例，没有跨请求污染。
    private string? _pendingExpected;

    private readonly ModelResolver _inner;
    private readonly MongoDbContext _db;
    private readonly IConfiguration _config;
    private readonly ILogger<ExpectedModelRespectingResolver> _logger;

    public ExpectedModelRespectingResolver(
        ModelResolver inner,
        MongoDbContext db,
        IConfiguration config,
        ILogger<ExpectedModelRespectingResolver> logger)
    {
        _inner = inner;
        _db = db;
        _config = config;
        _logger = logger;
    }

    public async Task<ModelResolutionResult> ResolveAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        CancellationToken ct = default)
    {
        var traceId = Guid.NewGuid().ToString("N")[..8];

        // ===== 关键：expectedModel 从 AsyncLocal 回放 =====
        // 背景：LlmGateway.SendRawAsync 内部再次调用 ResolveAsync 时 expectedModel 硬编码 null
        // （Infrastructure.dll 代码，改了部署不生效）。我们在第一次调用时把 expectedModel 存入
        // AsyncLocal，第二次调用 null 时从 AsyncLocal 读回。
        var effectiveExpected = expectedModel;
        if (string.IsNullOrWhiteSpace(effectiveExpected) && !string.IsNullOrWhiteSpace(_pendingExpected))
        {
            effectiveExpected = _pendingExpected;
            _logger.LogInformation(
                "[Resolver-Decorator:{Trace}] expectedModel=null，从 scope 实例字段恢复 '{Recovered}'（同 DI scope 前一次 ResolveAsync）",
                traceId, effectiveExpected);
        }
        else if (!string.IsNullOrWhiteSpace(expectedModel))
        {
            // 存入实例字段，供同 DI scope 后续调用读取
            _pendingExpected = expectedModel;
        }

        _logger.LogInformation(
            "[Resolver-Decorator:{Trace}] ENTRY appCallerCode={Code} modelType={Type} expectedModel='{Raw}' effective='{Effective}'",
            traceId, appCallerCode, modelType, expectedModel ?? "(null)", effectiveExpected ?? "(null)");

        if (string.IsNullOrWhiteSpace(effectiveExpected))
        {
            _logger.LogInformation(
                "[Resolver-Decorator:{Trace}] 无 effectiveExpected → 委派内部 resolver",
                traceId);
            return await _inner.ResolveAsync(appCallerCode, modelType, expectedModel, ct);
        }

        // 后续匹配逻辑用 effectiveExpected 代替 expectedModel
        expectedModel = effectiveExpected;

        // 查 AppCaller 绑定的候选池
        var appCaller = await _db.LLMAppCallers
            .Find(a => a.AppCode == appCallerCode)
            .FirstOrDefaultAsync(ct);
        if (appCaller == null)
        {
            _logger.LogWarning(
                "[Resolver-Decorator:{Trace}] AppCaller 未注册 → 委派内部 resolver",
                traceId);
            return await _inner.ResolveAsync(appCallerCode, modelType, expectedModel, ct);
        }

        var requirement = appCaller.ModelRequirements.FirstOrDefault(r => r.ModelType == modelType);
        if (requirement == null || requirement.ModelGroupIds.Count == 0)
        {
            _logger.LogInformation(
                "[Resolver-Decorator:{Trace}] AppCaller 未绑定 {Type} 池 → 委派内部 resolver",
                traceId, modelType);
            return await _inner.ResolveAsync(appCallerCode, modelType, expectedModel, ct);
        }

        var candidateGroups = await _db.ModelGroups
            .Find(g => requirement.ModelGroupIds.Contains(g.Id))
            .SortBy(g => g.Priority)
            .ToListAsync(ct);

        _logger.LogInformation(
            "[Resolver-Decorator:{Trace}] 候选池 {Count} 个: [{Pools}] key='{Key}'",
            traceId, candidateGroups.Count,
            string.Join(", ", candidateGroups.Select(g => $"{g.Name}(code={g.Code})")),
            expectedModel);

        // Tier 1：池内某个 ModelId 精确匹配 expectedModel
        foreach (var g in candidateGroups)
        {
            if (g.Models == null) continue;
            var m = g.Models.FirstOrDefault(x =>
                x.HealthStatus != ModelHealthStatus.Unavailable &&
                string.Equals(x.ModelId, expectedModel, StringComparison.OrdinalIgnoreCase));
            if (m != null)
            {
                _logger.LogInformation(
                    "[Resolver-Decorator:{Trace}] Tier1 命中: pool={Pool} modelId={ModelId}",
                    traceId, g.Name, m.ModelId);
                return await BuildFromPoolAsync(g, m, expectedModel, "DedicatedPool", traceId, ct);
            }
        }

        // Tier 2：ModelId 前缀匹配
        foreach (var g in candidateGroups)
        {
            if (g.Models == null) continue;
            var m = g.Models.FirstOrDefault(x =>
                x.HealthStatus != ModelHealthStatus.Unavailable &&
                !string.IsNullOrEmpty(x.ModelId) &&
                x.ModelId.StartsWith(expectedModel, StringComparison.OrdinalIgnoreCase));
            if (m != null)
            {
                _logger.LogInformation(
                    "[Resolver-Decorator:{Trace}] Tier2 命中（前缀）: pool={Pool} modelId={ModelId}",
                    traceId, g.Name, m.ModelId);
                return await BuildFromPoolAsync(g, m, expectedModel, "DedicatedPool", traceId, ct);
            }
        }

        // Tier 3：池名 / 池 Code 精确匹配（picker 发的 modelId 实际是池 Code）
        foreach (var g in candidateGroups)
        {
            if (g.Models == null || g.Models.Count == 0) continue;
            var byName = string.Equals(g.Name, expectedModel, StringComparison.OrdinalIgnoreCase);
            var byCode = string.Equals(g.Code, expectedModel, StringComparison.OrdinalIgnoreCase);
            if (!byName && !byCode) continue;

            var picked =
                g.Models.FirstOrDefault(x => x.HealthStatus == ModelHealthStatus.Healthy)
                ?? g.Models.FirstOrDefault(x => x.HealthStatus == ModelHealthStatus.Degraded);
            if (picked != null)
            {
                _logger.LogInformation(
                    "[Resolver-Decorator:{Trace}] Tier3 命中（池{By}）: pool={Pool} modelId={ModelId} health={Health}",
                    traceId, byCode ? "Code" : "Name", g.Name, picked.ModelId, picked.HealthStatus);
                return await BuildFromPoolAsync(g, picked, expectedModel, "DedicatedPool", traceId, ct);
            }

            _logger.LogWarning(
                "[Resolver-Decorator:{Trace}] Tier3 池名/Code 匹配 {Pool} 但无可用模型",
                traceId, g.Name);
        }

        _logger.LogWarning(
            "[Resolver-Decorator:{Trace}] ✗ expectedModel='{Expected}' 所有档位未命中 → 委派内部 resolver",
            traceId, expectedModel);
        return await _inner.ResolveAsync(appCallerCode, modelType, expectedModel, ct);
    }

    private async Task<ModelResolutionResult> BuildFromPoolAsync(
        ModelGroup group,
        ModelGroupItem selectedModel,
        string? expectedModel,
        string resolutionType,
        string traceId,
        CancellationToken ct)
    {
        var platform = await _db.LLMPlatforms
            .Find(p => p.Id == selectedModel.PlatformId && p.Enabled)
            .FirstOrDefaultAsync(ct);
        if (platform == null)
        {
            _logger.LogWarning(
                "[Resolver-Decorator:{Trace}] 命中池 {Pool} 的平台 {Pid} 未找到或未启用 → 返回 NotFound",
                traceId, group.Name, selectedModel.PlatformId);
            return ModelResolutionResult.NotFound(expectedModel,
                $"命中池 {group.Name} 但平台 {selectedModel.PlatformId} 未启用");
        }

        var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
        var apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted)
            ? null
            : Core.Helpers.ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);

        _logger.LogInformation(
            "[Resolver-Decorator:{Trace}] 返回 FromPool: pool={Pool} model={Model} platform={Platform}",
            traceId, group.Name, selectedModel.ModelId, platform.Name);

        return ModelResolutionResult.FromPool(
            resolutionType, expectedModel, selectedModel, group, platform, apiKey);
    }

    // ---- 其余接口方法全部委派给内部 ModelResolver ----

    public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode, string modelType, CancellationToken ct = default)
        => _inner.GetAvailablePoolsAsync(appCallerCode, modelType, ct);

    public Task RecordSuccessAsync(ModelResolutionResult resolution, CancellationToken ct = default)
        => _inner.RecordSuccessAsync(resolution, ct);

    public Task RecordFailureAsync(ModelResolutionResult resolution, CancellationToken ct = default)
        => _inner.RecordFailureAsync(resolution, ct);
}
