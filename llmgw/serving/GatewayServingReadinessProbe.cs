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
    private const string ModelCollection = "llmgw_models";

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
            var governed = await callers.Find(x => x.Status == "configured" || x.Status == "active")
                .ToListAsync(cancellationToken);

            /*
              判据必须按租户分开算。

              运行时解析每一次查询都带 `TenantId == 当前租户`（见 ModelResolver.CurrentTenantId），
              而这个组件原来把全库的模型、线路、平台、兑换所一锅端来判。多租户宿主上的后果是：
              租户 B 配了一个用途默认模型，就能让租户 A 的调用方在这里显示成可路由，
              而 A 的请求进到运行时一条都解析不到——一个没有任何调用方能用的部署照样报绿。

              所以按调用方自己的租户分组，逐组拿**那个租户的**数据判。调用方没写租户的
              （存量记录）落到宿主的内部租户，与运行时拿不到请求上下文时的兜底同源。
            */
            var catalogGateEnforces = await GatewayCatalogGate.EnforcesAsync(
                _configuration, _gatewayDb.Database, cancellationToken);

            var routableCallers = 0;
            foreach (var group in governed.GroupBy(CallerTenantId, StringComparer.Ordinal))
            {
                var view = await BuildTenantRouterViewAsync(
                    group.Key,
                    group.ToList(),
                    catalogGateEnforces,
                    cancellationToken);
                routableCallers += group.Count(view.IsRoutable);
            }

            var invalidCallers = governed.Count - routableCallers;
            // Readiness is instance-scoped. A single invalid caller is configuration degradation,
            // which the config-authority release gate blocks; taking every serving instance out
            // would turn one caller's bad binding into a global AI outage.
            if (governed.Count > 0 && routableCallers == 0)
            {
                throw new InvalidOperationException(
                    "no governed appCaller can be routed: neither a usable model pool nor a logical model "
                    + $"(claim or type default) with a usable offering; invalid={invalidCallers}");
            }

            return $"{routableCallers}/{governed.Count} governed appCallers routable, invalid={invalidCallers}";
        });
    }

    /// <summary>
    /// 这个调用方归哪个租户。空值落到宿主的内部租户——与运行时拿不到请求上下文时的兜底同源
    /// （ModelResolver.CurrentTenantId）。两边不同源的话，存量调用方会在这里按一套租户算、
    /// 在运行时按另一套算，判据又要分家。
    /// </summary>
    private string CallerTenantId(GatewayAppCallerRecord caller)
        => !string.IsNullOrWhiteSpace(caller.TenantId) ? caller.TenantId.Trim() : InternalTenantId;

    /// <summary>宿主自己的租户，取值方式与 ModelResolver 逐字同形。</summary>
    private string InternalTenantId
        => _configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } configured
            ? configured
            : GatewayTenantDefaults.InternalTenantId;

    /// <summary>一个租户的路由判据快照：池那条路与对外模型那条路共用它。</summary>
    private sealed record RouterTenantView(Func<GatewayAppCallerRecord, bool> IsRoutable);

    private async Task<RouterTenantView> BuildTenantRouterViewAsync(
        string tenantId,
        IReadOnlyList<GatewayAppCallerRecord> tenantCallers,
        bool catalogGateEnforces,
        CancellationToken cancellationToken)
    {
        var pools = _gatewayDb.Database.GetCollection<ModelGroup>(PoolCollection);
        var platforms = _gatewayDb.Database.GetCollection<LLMPlatform>(PlatformCollection);
        var exchanges = _gatewayDb.Database.GetCollection<ModelExchange>(ExchangeCollection);
        var logicalModels = _gatewayDb.Database.GetCollection<GatewayLogicalModel>(LogicalModelCollection);
        var offeringsCollection = _gatewayDb.Database.GetCollection<GatewayModelOffering>(OfferingCollection);
        var physicalModels = _gatewayDb.Database.GetCollection<BsonDocument>(ModelCollection);

        // 池、平台、兑换所、物理模型这几个类型上没有 TenantId 属性（它们是 MAP 侧的实体，
        // 租户是文档上的字段）。按字段名过滤，与 ModelResolver 里那几处逐字同形。
        var poolTenant = Builders<ModelGroup>.Filter.Eq("TenantId", tenantId);
        var platformTenant = Builders<LLMPlatform>.Filter.Eq("TenantId", tenantId);
        var exchangeTenant = Builders<ModelExchange>.Filter.Eq("TenantId", tenantId);

        var poolIds = tenantCallers
            .Select(x => x.ModelPoolId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var boundPools = poolIds.Count == 0
            ? new List<ModelGroup>()
            : await pools.Find(Builders<ModelGroup>.Filter.And(
                    poolTenant,
                    Builders<ModelGroup>.Filter.In(x => x.Id, poolIds)))
                .ToListAsync(cancellationToken);
        var requestTypes = tenantCallers
            .Select(x => x.RequestType)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var defaultPools = requestTypes.Count == 0
            ? new List<ModelGroup>()
            : await pools.Find(
                    Builders<ModelGroup>.Filter.And(
                        poolTenant,
                        Builders<ModelGroup>.Filter.Eq(x => x.IsDefaultForType, true),
                        Builders<ModelGroup>.Filter.In(x => x.ModelType, requestTypes)))
                .ToListAsync(cancellationToken);
        var enabledPlatformIds = (await platforms
                .Find(Builders<LLMPlatform>.Filter.And(
                    platformTenant,
                    Builders<LLMPlatform>.Filter.Eq(x => x.Enabled, true)))
                .Project(x => x.Id)
                .ToListAsync(cancellationToken))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var enabledExchanges = await exchanges
            .Find(Builders<ModelExchange>.Filter.And(
                exchangeTenant,
                Builders<ModelExchange>.Filter.Eq(x => x.Enabled, true)))
            .ToListAsync(cancellationToken);
        var poolById = boundPools.ToDictionary(x => x.Id, StringComparer.OrdinalIgnoreCase);

        /*
          池退场之后，「可路由」不再只有池这一条路。

          这个组件原来只按池算：调用方绑的池、或该用途的默认池。而正确迁移过来的部署
          一个池都不绑——不点名的请求由「对外模型认领」或「用途默认模型」接住。
          于是 routableCallers 恒为 0，readyz 对一个完全健康的部署报 503，
          编排会把它摘掉。判据没跟上现实，灯就开始说谎（与 2026-08-13 那次同形，只是反了个方向）。

          判据与运行时的两层同序：先看有没有对外模型认领了这个调用方，没有才看用途默认；
          两层都要求模型启用、且至少有一条启用且非 Unavailable 的线路。
          池那条留着不动：还没搬迁的部署仍然靠它，两条是或的关系。
        */
        var enabledLogicalModels = await logicalModels
            .Find(Builders<GatewayLogicalModel>.Filter.And(
                Builders<GatewayLogicalModel>.Filter.Eq(x => x.TenantId, tenantId),
                Builders<GatewayLogicalModel>.Filter.Eq(x => x.Enabled, true)))
            .ToListAsync(cancellationToken);
        var candidateOfferings = await offeringsCollection
            .Find(Builders<GatewayModelOffering>.Filter.And(
                Builders<GatewayModelOffering>.Filter.Eq(x => x.TenantId, tenantId),
                Builders<GatewayModelOffering>.Filter.Eq(x => x.Enabled, true),
                Builders<GatewayModelOffering>.Filter.Ne(x => x.HealthStatus, ModelHealthStatus.Unavailable)))
            .ToListAsync(cancellationToken);

        /*
          线路「启用且没被熔断」只是它自己的状态，**不代表它指向的东西还在**。

          上一版只看到这一层，于是一条指向已删除或已停用的物理模型 / 平台 / 兑换所的线路
          也被算成可用——两个就绪组件都报绿，而运行时把每一条都拒掉。
          这正是池那一侧早就做对的事（IsPoolRoutableForRequestType → HasEnabledBackend），
          我加对外模型这条路时没把它一起带过来。

          物理模型还要多过一道名录门：启用着、平台也开着的模型，只要既不在名录里、
          又没有管理员显式放行的戳，运行时就回 MODEL_NOT_IN_CATALOG。不判这一层的话，
          一个所有线路都被名录门拦死的部署照样报绿，而每一次真实调用都失败。
          「要不要拦」与运行时同源（GatewayCatalogGate），降到 observe 或补标记没跑完时
          这里也跟着不拦——否则又走到另一边去了。
        */
        var offeringModelTargetIds = candidateOfferings
            .Where(x => !string.Equals(x.TargetKind, "exchange", StringComparison.OrdinalIgnoreCase))
            .Select(x => x.TargetId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var enabledOfferingModels = offeringModelTargetIds.Count == 0
            ? new List<BsonDocument>()
            : await physicalModels
                .Find(Builders<BsonDocument>.Filter.And(
                    Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
                    Builders<BsonDocument>.Filter.In("_id", offeringModelTargetIds),
                    Builders<BsonDocument>.Filter.Eq("Enabled", true)))
                .ToListAsync(cancellationToken);
        var enabledOfferingModelPlatformById = enabledOfferingModels
            .Where(x => !catalogGateEnforces || GatewayCatalogGate.Passes(x))
            .Select(x => (
                Id: x.GetValue("_id", BsonNull.Value) is { IsString: true } id ? id.AsString : string.Empty,
                PlatformId: x.GetValue("PlatformId", BsonNull.Value) is { IsString: true } pid ? pid.AsString : string.Empty))
            .Where(x => x.Id.Length > 0)
            .GroupBy(x => x.Id, StringComparer.Ordinal)
            .ToDictionary(x => x.Key, x => x.First().PlatformId, StringComparer.Ordinal);
        var enabledExchangeById = enabledExchanges
            .Where(x => !string.IsNullOrWhiteSpace(x.Id))
            .ToDictionary(x => x.Id, StringComparer.Ordinal);

        // 兑换所那一支要判到**别名**这一层，不能只判兑换所文档启用。
        //
        // 线路打给上游的是哪一个别名由 UpstreamModelId 决定（没写就回落到兑换所主别名）。
        // 别名被摘掉之后兑换所照样启用着，而运行时按名录门把它判死——一个所有兑换所线路
        // 都已失效的部署会在这里报绿，而每一次真实请求都失败。
        // 判据用共享那一份，与运行时和对外模型清单同源；上一轮补清单那一处时漏了这里
        // （形状 6 的老毛病：补洞只补被点名的那一处，没把同族的其余出口扫完）。
        bool OfferingTargetUsable(GatewayModelOffering offering)
            => string.Equals(offering.TargetKind, "exchange", StringComparison.OrdinalIgnoreCase)
                ? enabledExchangeById.TryGetValue(offering.TargetId, out var exchange)
                  && GatewayCatalogGate.ExchangeRoutePasses(exchange, offering.UpstreamModelId, catalogGateEnforces)
                : enabledOfferingModelPlatformById.TryGetValue(offering.TargetId, out var platformId)
                  && platformId.Length > 0
                  && enabledPlatformIds.Contains(platformId);

        var routableLogicalModelIds = candidateOfferings
            .Where(OfferingTargetUsable)
            .Select(x => x.LogicalModelId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .ToHashSet(StringComparer.Ordinal);

        bool HasLogicalCatcher(GatewayAppCallerRecord caller)
        {
            if (string.IsNullOrWhiteSpace(caller.RequestType)) return false;
            var candidates = enabledLogicalModels
                .Where(x => string.Equals(x.ModelType, caller.RequestType, StringComparison.Ordinal)
                    && routableLogicalModelIds.Contains(x.Id))
                .ToList();
            if (candidates.Count == 0) return false;

            // 被选中的那个候选还得满足这个调用方的场景能力要求。
            //
            // 不判的话会出现这种组合：模型 A 认领了这个调用方但不具备它要的能力，
            // 模型 B 具备能力却没认领它。router 组件看 A 判绿、场景组件看 B 也判绿，
            // 而运行时按认领选中 A，回一个能力不匹配——两个组件各自为真，合起来是假的。
            // 判据用的是运行时那一份（GatewayCapabilityContract），不另写近似。
            bool Serves(GatewayLogicalModel model)
                => GatewayCapabilityContract.SupportsAppCallerScenario(
                    model.Capabilities, model.AllowedAppCallerCodes, caller.AppCallerCode);

            // 第一层：谁认领了它。认领是排他的，所以只看被认领的那个候选，不看别人。
            var claimed = candidates.FirstOrDefault(x => x.DefaultForAppCallerCodes
                .Contains(caller.AppCallerCode, StringComparer.OrdinalIgnoreCase));
            if (claimed is not null) return Serves(claimed);

            // 第二层：这个用途的默认。
            var typeDefault = candidates.FirstOrDefault(x => x.IsDefaultForType);
            return typeDefault is not null && Serves(typeDefault);
        }

        return new RouterTenantView(caller => IsCallerRoutable(
            caller,
            poolById,
            defaultPools,
            enabledPlatformIds,
            enabledExchanges) || HasLogicalCatcher(caller));
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

        return EvaluateScenarioCapability(
            governed,
            enabledModels,
            usableOfferings,
            internalTenantId: InternalTenantId);
    }

    /// <summary>
    /// 场景能力判定的纯函数入口（不碰 IO），供单测直接断言。
    /// 判据本体仍在 <see cref="GatewayCapabilityContract"/>，这里只负责「哪些对象参与判定」。
    ///
    /// <paramref name="internalTenantId"/> 是必填的：运行时每一次查询都带租户，
    /// 这里不带的话，租户 B 的模型会让租户 A 的调用方显示成可路由，而 A 的请求一条都解析不到。
    /// 做成必填参数而不是可选项，是为了让「忘了传租户」编译不过——这条不变量用类型表达，
    /// 比写一条守卫去抽查强一个量级。
    /// </summary>
    public static GatewayScenarioCapabilitySnapshot EvaluateScenarioCapability(
        IReadOnlyCollection<GatewayAppCallerRecord> governedCallers,
        IReadOnlyCollection<GatewayLogicalModel> enabledLogicalModels,
        IReadOnlyCollection<GatewayModelOffering> usableOfferings,
        string internalTenantId)
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
            // 租户判据与运行时逐字同形：调用方没写租户的落到内部租户，模型侧**不做**同样的兜底。
            // 模型那边也兜的话会比运行时宽——运行时是 Eq(TenantId, 当前租户) 的严格相等，
            // 一条 TenantId 为空的存量模型它一条都不会选中。宽了就又回到「这里绿、那里红」。
            var callerTenant = !string.IsNullOrWhiteSpace(caller.TenantId)
                ? caller.TenantId.Trim()
                : internalTenantId;
            var capable = enabledLogicalModels.Any(model =>
                model.Enabled
                && string.Equals(model.TenantId, callerTenant, StringComparison.Ordinal)
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
