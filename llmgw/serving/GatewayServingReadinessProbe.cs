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

            /*
              池那条路已经删掉了，判据也必须跟着删。

              运行时的 ResolveCoreAsync 里现在**没有任何池分支**（2026-09-15 断流后删的）。
              而这个组件此前还写着「绑了一个健康的池也算可路由」，理由是「还没搬迁的部署仍然靠它」——
              那句话在删掉池分支的那一刻就不成立了。后果是最坏的一种：一个调用方只绑着池、
              没有任何模型认领它、这个用途也没有默认模型时，探针报绿，而它的每一次不点名请求
              都回 MODEL_NOT_FOUND。判据留着一条运行时已经不存在的路，就是让灯替一条死路作保。
            */
            var routableCallers = 0;
            foreach (var group in governed.GroupBy(CallerTenantId, StringComparer.Ordinal))
            {
                var view = await BuildTenantRoutingViewAsync(group.Key, catalogGateEnforces, cancellationToken);
                routableCallers += group.Count(caller => HasLogicalCatcher(caller, view));
            }

            var invalidCallers = governed.Count - routableCallers;
            // Readiness is instance-scoped. A single invalid caller is configuration degradation,
            // which the config-authority release gate blocks; taking every serving instance out
            // would turn one caller's bad binding into a global AI outage.
            if (governed.Count > 0 && routableCallers == 0)
            {
                throw new InvalidOperationException(
                    "no governed appCaller can be routed: no logical model (claim or type default) "
                    + $"with a usable offering; invalid={invalidCallers}");
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

    /// <summary>
    /// 一个租户里「谁接得住不点名的请求」所需的全部事实：启用着的对外模型，
    /// 以及其中至少有一条**真能用**的线路的那些（线路启用、没被熔断、指向的东西还在、过得了名录门）。
    ///
    /// router 与 scenario-capability 两个组件共用它。此前两个组件各查各的、各判各的，
    /// 于是同一份配置能让一个判绿、另一个判红——而它们问的本来就是同一件事的两个侧面。
    /// </summary>
    private sealed record TenantRoutingView(
        IReadOnlyList<GatewayLogicalModel> EnabledLogicalModels,
        IReadOnlySet<string> RoutableLogicalModelIds);

    private async Task<TenantRoutingView> BuildTenantRoutingViewAsync(
        string tenantId,
        bool catalogGateEnforces,
        CancellationToken cancellationToken)
    {
        var platforms = _gatewayDb.Database.GetCollection<LLMPlatform>(PlatformCollection);
        var exchanges = _gatewayDb.Database.GetCollection<ModelExchange>(ExchangeCollection);
        var logicalModels = _gatewayDb.Database.GetCollection<GatewayLogicalModel>(LogicalModelCollection);
        var offeringsCollection = _gatewayDb.Database.GetCollection<GatewayModelOffering>(OfferingCollection);
        var physicalModels = _gatewayDb.Database.GetCollection<BsonDocument>(ModelCollection);

        // 平台、兑换所、物理模型这几个类型上没有 TenantId 属性（它们是 MAP 侧的实体，
        // 租户是文档上的字段）。按字段名过滤，与 ModelResolver 里那几处逐字同形。
        var enabledPlatformIds = (await platforms
                .Find(Builders<LLMPlatform>.Filter.And(
                    Builders<LLMPlatform>.Filter.Eq("TenantId", tenantId),
                    Builders<LLMPlatform>.Filter.Eq(x => x.Enabled, true)))
                .Project(x => x.Id)
                .ToListAsync(cancellationToken))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var enabledExchanges = await exchanges
            .Find(Builders<ModelExchange>.Filter.And(
                Builders<ModelExchange>.Filter.Eq("TenantId", tenantId),
                Builders<ModelExchange>.Filter.Eq(x => x.Enabled, true)))
            .ToListAsync(cancellationToken);

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

          只看这一层的话，一条指向已删除或已停用的物理模型 / 平台 / 兑换所的线路也被算成可用——
          就绪组件报绿，而运行时把每一条都拒掉。

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
        // 都已失效的部署会在这里报绿，而每一次真实请求都失败。判据用共享那一份。
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

        return new TenantRoutingView(enabledLogicalModels, routableLogicalModelIds);
    }

    /// <summary>
    /// 不点名的请求有没有对外模型接得住，判据与运行时的两层同序：
    /// 先看有没有模型认领了这个调用方，没有才看这个用途的默认；被选中的那一条还得支持它的场景。
    /// </summary>
    private static bool HasLogicalCatcher(GatewayAppCallerRecord caller, TenantRoutingView view)
    {
        if (string.IsNullOrWhiteSpace(caller.RequestType)) return false;
        var candidates = view.EnabledLogicalModels
            .Where(x => string.Equals(x.ModelType, caller.RequestType, StringComparison.Ordinal)
                && view.RoutableLogicalModelIds.Contains(x.Id))
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

        var governed = await callers.Find(x => x.Status == "configured" || x.Status == "active")
            .ToListAsync(cancellationToken);
        if (governed.All(x => GatewayCapabilityContract.RequiredScenarioCapability(x.AppCallerCode) is null))
            return new GatewayScenarioCapabilitySnapshot(0, 0, []);

        /*
          可用线路的判据与 router 组件共用同一份视图。

          此前这里只问「线路 enabled 且没被熔断」，不问它指向的物理模型 / 平台 / 兑换所别名
          还在不在、过不过得了名录门。于是同一份配置能让 router 判红、scenario 判绿——
          两个组件问的本来就是同一件事的两个侧面，判据却是两份（形状 3）。
          现在两边都从 BuildTenantRoutingViewAsync 取，那一份改了两边同时改。
        */
        var catalogGateEnforces = await GatewayCatalogGate.EnforcesAsync(
            _configuration, _gatewayDb.Database, cancellationToken);

        var scenarioCallers = 0;
        var routable = 0;
        var broken = new List<string>();
        foreach (var group in governed.GroupBy(CallerTenantId, StringComparer.Ordinal))
        {
            var view = await BuildTenantRoutingViewAsync(group.Key, catalogGateEnforces, cancellationToken);
            var part = EvaluateScenarioCapability(
                group.ToList(),
                view.EnabledLogicalModels,
                view.RoutableLogicalModelIds,
                internalTenantId: InternalTenantId);
            scenarioCallers += part.ScenarioCallers;
            routable += part.RoutableCallers;
            broken.AddRange(part.BrokenCallers);
        }

        return new GatewayScenarioCapabilitySnapshot(scenarioCallers, routable, broken);
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
        IReadOnlySet<string> routableLogicalModelIds,
        string internalTenantId)
    {
        var scenarioCallers = governedCallers
            .Where(x => GatewayCapabilityContract.RequiredScenarioCapability(x.AppCallerCode) is not null)
            .ToList();
        if (scenarioCallers.Count == 0)
            return new GatewayScenarioCapabilitySnapshot(0, 0, []);

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
                && routableLogicalModelIds.Contains(model.Id)
                && GatewayCapabilityContract.SupportsAppCallerScenario(
                    model.Capabilities,
                    model.AllowedAppCallerCodes,
                    caller.AppCallerCode));
            if (capable) routable++;
            else broken.Add(caller.AppCallerCode);
        }

        return new GatewayScenarioCapabilitySnapshot(scenarioCallers.Count, routable, broken);
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
