using System.Diagnostics;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.LlmGatewayHost;

public interface IGatewayServingReadinessProbe
{
    Task<GatewayServingReadinessSnapshot> CheckAsync(CancellationToken cancellationToken);
}

public sealed record GatewayServingReadinessComponent(
    string Name,
    bool Ready,
    long DurationMs,
    string Summary);

public sealed record GatewayServingReadinessSnapshot(
    bool Ready,
    DateTime CheckedAt,
    IReadOnlyList<GatewayServingReadinessComponent> Components);

/// <summary>
/// 场景能力可路由性快照。
/// </summary>
/// <param name="ScenarioCallers">带图片场景要求的治理内 appCaller 数量。</param>
/// <param name="RoutableCallers">其中能解析到「能力匹配 + 有可用 Offering」逻辑模型的数量。</param>
/// <param name="BrokenCallers">解析不到的 appCaller 点名清单，发布门禁按它逐个整改。</param>
public sealed record GatewayScenarioCapabilitySnapshot(
    int ScenarioCallers,
    int RoutableCallers,
    IReadOnlyList<string> BrokenCallers);

public sealed class GatewayServingReadinessProbe : IGatewayServingReadinessProbe
{
    private const string AppCallerCollection = "llmgw_app_callers";
    private const string PoolCollection = "llmgw_model_pools";
    private const string PlatformCollection = "llmgw_platforms";
    private const string ExchangeCollection = "llmgw_model_exchanges";
    private const string LogicalModelCollection = "llmgw_logical_models";
    private const string OfferingCollection = "llmgw_model_offerings";

    private readonly LlmGatewayDataContext _gatewayDb;
    private readonly IAssetStorage _assetStorage;
    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<GatewayServingReadinessProbe> _logger;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private GatewayServingReadinessSnapshot? _cached;
    private DateTime _cachedAt;

    public GatewayServingReadinessProbe(
        LlmGatewayDataContext gatewayDb,
        IAssetStorage assetStorage,
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<GatewayServingReadinessProbe> logger)
    {
        _gatewayDb = gatewayDb;
        _assetStorage = assetStorage;
        _configuration = configuration;
        _environment = environment;
        _logger = logger;
    }

    public async Task<GatewayServingReadinessSnapshot> CheckAsync(CancellationToken cancellationToken)
    {
        var cacheSeconds = Math.Clamp(
            _configuration.GetValue("LlmGateway:Readiness:CacheSeconds", 10),
            1,
            60);
        var cached = _cached;
        if (cached != null && DateTime.UtcNow - _cachedAt < TimeSpan.FromSeconds(cacheSeconds))
            return cached;

        await _refreshLock.WaitAsync(cancellationToken);
        try
        {
            cached = _cached;
            if (cached != null && DateTime.UtcNow - _cachedAt < TimeSpan.FromSeconds(cacheSeconds))
                return cached;

            var refreshed = await CheckFreshAsync(cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            _cached = refreshed;
            _cachedAt = DateTime.UtcNow;
            return refreshed;
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    private async Task<GatewayServingReadinessSnapshot> CheckFreshAsync(CancellationToken cancellationToken)
    {
        var timeoutSeconds = Math.Clamp(
            _configuration.GetValue("LlmGateway:Readiness:ProbeTimeoutSeconds", 10),
            1,
            30);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));

        var components = new List<GatewayServingReadinessComponent>
        {
            await CheckMongoAsync("gateway-mongo", _gatewayDb.Database, timeout.Token),
            await CheckAssetStorageAsync(timeout.Token),
            await CheckKeyIntegrityAsync(timeout.Token),
            await CheckRouterAsync(timeout.Token),
            await CheckScenarioCapabilityAsync(timeout.Token),
        };

        return new GatewayServingReadinessSnapshot(
            components.All(x => x.Ready),
            DateTime.UtcNow,
            components);
    }

    private async Task<GatewayServingReadinessComponent> CheckMongoAsync(
        string name,
        IMongoDatabase database,
        CancellationToken cancellationToken)
    {
        return await MeasureAsync(name, async () =>
        {
            await database.RunCommandAsync<BsonDocument>(
                new BsonDocument("ping", 1),
                cancellationToken: cancellationToken);
            return "ping ok";
        });
    }

    private async Task<GatewayServingReadinessComponent> CheckAssetStorageAsync(CancellationToken cancellationToken)
    {
        var requireProbe = _configuration.GetValue(
            "LlmGateway:Readiness:RequireAssetProbe",
            _environment.IsProduction());
        var probeKey = _configuration["LlmGateway:Readiness:AssetProbeKey"]?.Trim();

        if (string.IsNullOrWhiteSpace(probeKey))
        {
            return new GatewayServingReadinessComponent(
                "asset-storage",
                !requireProbe,
                0,
                requireProbe ? "probe key missing" : "probe disabled");
        }

        return await MeasureAsync("asset-storage", async () =>
        {
            var exists = await _assetStorage.ExistsAsync(probeKey, cancellationToken);
            if (!exists)
                throw new InvalidOperationException("configured probe object is not reachable");
            return "probe object reachable";
        });
    }

    private async Task<GatewayServingReadinessComponent> CheckKeyIntegrityAsync(CancellationToken cancellationToken)
    {
        return await MeasureAsync("key-integrity", async () =>
        {
            var platforms = _gatewayDb.Database.GetCollection<LLMPlatform>(PlatformCollection);
            var exchanges = _gatewayDb.Database.GetCollection<ModelExchange>(ExchangeCollection);
            var enabledPlatforms = await platforms.Find(x => x.Enabled).ToListAsync(cancellationToken);
            var enabledExchanges = await exchanges.Find(x => x.Enabled).ToListAsync(cancellationToken);

            var encryptedKeys = enabledPlatforms
                .Select(x => x.ApiKeyEncrypted)
                .Concat(enabledExchanges.Select(x => x.TargetApiKeyEncrypted))
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .ToList();
            var failed = encryptedKeys.Count(x => !ApiKeyCryptoKeyRing.Decrypt(x, _configuration).Success);
            if (failed > 0)
                throw new InvalidOperationException($"{failed} enabled provider keys cannot be decrypted");

            return $"{encryptedKeys.Count} encrypted provider keys verified";
        });
    }

    private async Task<GatewayServingReadinessComponent> CheckRouterAsync(CancellationToken cancellationToken)
    {
        return await MeasureAsync("router", async () =>
        {
            var callers = _gatewayDb.Database.GetCollection<GatewayAppCallerRecord>(AppCallerCollection);
            var pools = _gatewayDb.Database.GetCollection<ModelGroup>(PoolCollection);
            var platforms = _gatewayDb.Database.GetCollection<LLMPlatform>(PlatformCollection);
            var exchanges = _gatewayDb.Database.GetCollection<ModelExchange>(ExchangeCollection);
            var governed = await callers.Find(x => x.Status == "configured" || x.Status == "active")
                .ToListAsync(cancellationToken);
            var poolIds = governed
                .Select(x => x.ModelPoolId)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x!)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var boundPools = poolIds.Count == 0
                ? new List<ModelGroup>()
                : await pools.Find(Builders<ModelGroup>.Filter.In(x => x.Id, poolIds))
                    .ToListAsync(cancellationToken);
            var requestTypes = governed
                .Select(x => x.RequestType)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Distinct(StringComparer.Ordinal)
                .ToList();
            var defaultPools = requestTypes.Count == 0
                ? new List<ModelGroup>()
                : await pools.Find(
                        Builders<ModelGroup>.Filter.And(
                            Builders<ModelGroup>.Filter.Eq(x => x.IsDefaultForType, true),
                            Builders<ModelGroup>.Filter.In(x => x.ModelType, requestTypes)))
                    .ToListAsync(cancellationToken);
            var enabledPlatformIds = (await platforms.Find(x => x.Enabled)
                    .Project(x => x.Id)
                    .ToListAsync(cancellationToken))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            var enabledExchanges = await exchanges.Find(x => x.Enabled).ToListAsync(cancellationToken);
            var poolById = boundPools.ToDictionary(x => x.Id, StringComparer.OrdinalIgnoreCase);
            var routableCallers = governed.Count(x => IsCallerRoutable(
                x,
                poolById,
                defaultPools,
                enabledPlatformIds,
                enabledExchanges));
            var invalidCallers = governed.Count - routableCallers;
            // Readiness is instance-scoped. A single invalid caller is configuration degradation,
            // which the config-authority release gate blocks; taking every serving instance out
            // would turn one caller's bad binding into a global AI outage.
            if (governed.Count > 0 && routableCallers == 0)
            {
                throw new InvalidOperationException(
                    $"no governed appCaller has a usable model pool: invalid={invalidCallers}");
            }

            return $"{routableCallers}/{governed.Count} governed appCallers routable, invalid={invalidCallers}";
        });
    }

    /// <summary>
    /// 场景能力可路由性检查。
    ///
    /// 为什么必须有这一条：原来的 readiness 只看「池在不在、有没有成员、平台开没开、成员是不是 Unavailable」，
    /// 唯独不跑 MAP 运行时真正用的 <c>SupportsAppCallerScenario</c>。
    /// 于是 2026-08-13 那次故障里，CI 绿、容器绿、Gateway readiness 绿，
    /// 而真实生图调用的候选模型数是 0——所有灯都亮着，功能是死的。
    ///
    /// 这里调用的是**与生产运行时同一个判据函数**（<see cref="GatewayCapabilityContract"/>），
    /// 不是另写一份近似逻辑；判据一改两边同时改，不存在再次漂移的空间。
    /// </summary>
    private async Task<GatewayServingReadinessComponent> CheckScenarioCapabilityAsync(
        CancellationToken cancellationToken)
    {
        return await MeasureAsync("scenario-capability", async () =>
        {
            var snapshot = await BuildScenarioCapabilitySnapshotAsync(cancellationToken);
            if (snapshot.ScenarioCallers == 0)
                return "no scenario-bound appCaller";

            // 与 router 组件同口径：单个 appCaller 配错属于配置退化，由发布门禁拦；
            // 把每个 serving 实例都摘掉会让一个错绑定升级成全站 AI 宕机。
            // 但「全部场景调用方都不可路由」正是本次事故的形状，必须红。
            if (snapshot.RoutableCallers == 0)
            {
                throw new InvalidOperationException(
                    "no scenario-bound appCaller can resolve a capable logical model: "
                    + string.Join(", ", snapshot.BrokenCallers));
            }

            var broken = snapshot.ScenarioCallers - snapshot.RoutableCallers;
            return broken == 0
                ? $"{snapshot.RoutableCallers}/{snapshot.ScenarioCallers} scenario appCallers capable"
                : $"{snapshot.RoutableCallers}/{snapshot.ScenarioCallers} scenario appCallers capable, "
                  + $"degraded={string.Join(",", snapshot.BrokenCallers)}";
        });
    }

    /// <summary>
    /// 计算「每个带场景要求的 appCaller 是否至少有一个能力匹配且有可用 Offering 的逻辑模型」。
    /// 发布门禁需要逐个 appCaller 的明细，所以这里独立成方法并公开快照。
    /// </summary>
    public async Task<GatewayScenarioCapabilitySnapshot> BuildScenarioCapabilitySnapshotAsync(
        CancellationToken cancellationToken)
    {
        var callers = _gatewayDb.Database.GetCollection<GatewayAppCallerRecord>(AppCallerCollection);
        var logicalModels = _gatewayDb.Database.GetCollection<GatewayLogicalModel>(LogicalModelCollection);
        var offerings = _gatewayDb.Database.GetCollection<GatewayModelOffering>(OfferingCollection);

        var governed = await callers.Find(x => x.Status == "configured" || x.Status == "active")
            .ToListAsync(cancellationToken);
        if (governed.All(x => GatewayCapabilityContract.RequiredScenarioCapability(x.AppCallerCode) is null))
            return new GatewayScenarioCapabilitySnapshot(0, 0, []);

        var enabledModels = await logicalModels.Find(x => x.Enabled).ToListAsync(cancellationToken);
        var usableOfferings = await offerings
            .Find(Builders<GatewayModelOffering>.Filter.And(
                Builders<GatewayModelOffering>.Filter.Eq(x => x.Enabled, true),
                Builders<GatewayModelOffering>.Filter.Ne(x => x.HealthStatus, ModelHealthStatus.Unavailable)))
            .ToListAsync(cancellationToken);

        return EvaluateScenarioCapability(governed, enabledModels, usableOfferings);
    }

    /// <summary>
    /// 场景能力判定的纯函数入口（不碰 IO），供单测直接断言。
    /// 判据本体仍在 <see cref="GatewayCapabilityContract"/>，这里只负责「哪些对象参与判定」。
    /// </summary>
    public static GatewayScenarioCapabilitySnapshot EvaluateScenarioCapability(
        IReadOnlyCollection<GatewayAppCallerRecord> governedCallers,
        IReadOnlyCollection<GatewayLogicalModel> enabledLogicalModels,
        IReadOnlyCollection<GatewayModelOffering> usableOfferings)
    {
        var scenarioCallers = governedCallers
            .Where(x => GatewayCapabilityContract.RequiredScenarioCapability(x.AppCallerCode) is not null)
            .ToList();
        if (scenarioCallers.Count == 0)
            return new GatewayScenarioCapabilitySnapshot(0, 0, []);

        var logicalIdsWithOffering = usableOfferings
            .Where(x => x.Enabled && x.HealthStatus != ModelHealthStatus.Unavailable)
            .Select(x => x.LogicalModelId)
            .ToHashSet(StringComparer.Ordinal);

        var broken = new List<string>();
        var routable = 0;
        foreach (var caller in scenarioCallers)
        {
            var capable = enabledLogicalModels.Any(model =>
                model.Enabled
                && string.Equals(model.ModelType, caller.RequestType, StringComparison.OrdinalIgnoreCase)
                && logicalIdsWithOffering.Contains(model.Id)
                && GatewayCapabilityContract.SupportsAppCallerScenario(
                    model.Capabilities,
                    model.AllowedAppCallerCodes,
                    caller.AppCallerCode));
            if (capable) routable++;
            else broken.Add(caller.AppCallerCode);
        }

        return new GatewayScenarioCapabilitySnapshot(scenarioCallers.Count, routable, broken);
    }

    public static bool IsCallerRoutable(
        GatewayAppCallerRecord caller,
        IReadOnlyDictionary<string, ModelGroup> poolById,
        IReadOnlyCollection<ModelGroup> defaultPools,
        IReadOnlySet<string> enabledPlatformIds,
        IReadOnlyCollection<ModelExchange> enabledExchanges)
    {
        if (!string.IsNullOrWhiteSpace(caller.ModelPoolId))
        {
            return poolById.TryGetValue(caller.ModelPoolId, out var boundPool) &&
                   IsPoolRoutableForRequestType(
                       boundPool,
                       caller.RequestType,
                       enabledPlatformIds,
                       enabledExchanges);
        }

        return defaultPools.Any(pool =>
            pool.IsDefaultForType &&
            IsPoolRoutableForRequestType(
                pool,
                caller.RequestType,
                enabledPlatformIds,
                enabledExchanges));
    }

    private static bool IsPoolRoutableForRequestType(
        ModelGroup pool,
        string requestType,
        IReadOnlySet<string> enabledPlatformIds,
        IReadOnlyCollection<ModelExchange> enabledExchanges)
        => pool.ModelType == requestType &&
           pool.Models.Count > 0 &&
           pool.Models.Any(model =>
               model.HealthStatus != ModelHealthStatus.Unavailable &&
               HasEnabledBackend(model, enabledPlatformIds, enabledExchanges));

    private static bool HasEnabledBackend(
        ModelGroupItem model,
        IReadOnlySet<string> enabledPlatformIds,
        IReadOnlyCollection<ModelExchange> enabledExchanges)
    {
        if (enabledPlatformIds.Contains(model.PlatformId))
            return true;

        if (model.PlatformId == ModelResolverConstants.ExchangePlatformId)
        {
            return enabledExchanges.Any(exchange => exchange.GetEffectiveModels().Any(candidate =>
                candidate.Enabled && candidate.ModelId == model.ModelId));
        }

        return enabledExchanges.Any(exchange =>
            exchange.Id == model.PlatformId &&
            exchange.GetEffectiveModels().Any(candidate =>
                candidate.Enabled && candidate.ModelId == model.ModelId));
    }

    private async Task<GatewayServingReadinessComponent> MeasureAsync(
        string name,
        Func<Task<string>> action)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            var summary = await action();
            return new GatewayServingReadinessComponent(name, true, stopwatch.ElapsedMilliseconds, summary);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                "LLM Gateway readiness component failed: component={Component}, exceptionType={ExceptionType}",
                name,
                ex.GetType().Name);
            return new GatewayServingReadinessComponent(
                name,
                false,
                stopwatch.ElapsedMilliseconds,
                ex is OperationCanceledException ? "probe timeout" : "probe failed");
        }
    }
}
