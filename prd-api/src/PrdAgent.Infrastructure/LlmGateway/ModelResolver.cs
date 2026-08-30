using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 模型调度执行器实现
/// </summary>
public class ModelResolver : IModelResolver
{
    private readonly MongoDbContext _db;
    private readonly LlmGatewayDataContext? _gatewayDb;
    private readonly IConfiguration _config;
    private readonly ILogger<ModelResolver> _logger;
    private readonly ILLMRequestContextAccessor? _requestContext;
    private readonly string _internalTenantId;

    /// <summary>
    /// 名录门的执行档。默认 enforce（拦下并结构化失败）。
    ///
    /// 之所以要有 observe 档：这道门是**后加的**，而库里可能已经躺着名录外的模型
    /// （在这道门存在之前导入的，那时还没有放行标记这回事）。一上来就 enforce，
    /// 那些池会在下一次请求时集体开始失败，而管理员从错误码里才第一次得知这件事——
    /// 用「变更前就存在的状态」去判定，正是 predicate-and-wiring-discipline 形状 5 的场景。
    /// observe 档只记日志不拦，用来先看清楚「到底有多少存量会被拦」，再决定什么时候收紧。
    /// </summary>
    private readonly bool _catalogGateEnforces;

    public ModelResolver(
        MongoDbContext db,
        IConfiguration config,
        ILogger<ModelResolver> logger,
        LlmGatewayDataContext? gatewayDb = null,
        ILLMRequestContextAccessor? requestContext = null)
    {
        _db = db;
        _gatewayDb = gatewayDb;
        _config = config;
        _logger = logger;
        _requestContext = requestContext;
        _internalTenantId = config["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } tenantId
            ? tenantId
            : GatewayTenantDefaults.InternalTenantId;
        // 只认 "observe" 这一个降档值；拼错、留空、写别的都落回 enforce——
        // 一道安全门不该因为配置写错就悄悄敞开。
        _catalogGateEnforces = !string.Equals(
            config["LlmGateway:ModelCatalogGate"]?.Trim(), "observe", StringComparison.OrdinalIgnoreCase);
    }

    /// <inheritdoc />
    public async Task<ModelResolutionResult> ResolveAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null,
        CancellationToken ct = default)
    {
        /*
          白名单第二道门。刻意做成「罩住整个解析」而不是「在每个 return 前判一次」——
          下面那个方法有十几个成功出口（池 / 逻辑模型 / Offering / pinned / legacy 降级），
          逐个补判据必然漏，而漏掉的那条正好是没人走过的分支（形状 2：链路只建到一半）。
          薄壳只有一个出口，新增分支自动被罩住。
        */
        var resolved = await ResolveCoreAsync(appCallerCode, modelType, expectedModel, pinnedPlatformId, pinnedModelId, ct);
        return await ApplyCatalogGateAsync(resolved, appCallerCode, ct);
    }

    /// <summary>
    /// 名录门（白名单的第二道，也是最后一道）。
    ///
    /// 第一道在控制台导入那一步：名录外模型要管理员显式放行才准入库，用户在那一刻就知道
    /// 被拦了、为什么、怎么放行。这一道兜住**绕过控制台的路径**——直接写库、历史遗留数据、
    /// 别的写入方——因为请求最终只认「库里有什么」，不认「它是怎么进来的」。
    ///
    /// 判定顺序刻意是「先查名录，查不到才读库」：名录命中零额外开销（绝大多数请求），
    /// 只有名录外的模型才多一次带索引的文档读，用来看它有没有被放行过的戳。
    ///
    /// 重试候选一并过门：把主选拦下却把同样越界的候选留在重试链上，等于换条路照样打出去。
    /// </summary>
    private async Task<ModelResolutionResult> ApplyCatalogGateAsync(
        ModelResolutionResult resolved,
        string appCallerCode,
        CancellationToken ct)
    {
        if (!resolved.Success) return resolved;

        // 主选与整条重试链一次取回。逐个判的话，一个成员全是名录外私有模型的大池
        // （真实租户上有两百多个成员）会在打上游之前先串行做上百次带索引的读——
        // 判据没错，代价错了。名录内的成员在 JudgeAsync 开头就返回，本来就不进这一批。
        var gateTargets = new List<ModelResolutionResult> { resolved };
        if (resolved.RetryCandidates is { Count: > 0 }) gateTargets.AddRange(resolved.RetryCandidates);
        var batch = await PrefetchCatalogDocsAsync(gateTargets, ct);

        if (await JudgeAsync(resolved.ActualModel, resolved.ActualPlatformId, ct, batch) != CatalogVerdict.Blocked)
        {
            // 主选放行；重试链里越界的成员要摘掉，否则第一次失败后照样会打出去。
            if (resolved.RetryCandidates is { Count: > 0 })
            {
                var kept = new List<ModelResolutionResult>();
                foreach (var candidate in resolved.RetryCandidates)
                {
                    if (await JudgeAsync(candidate.ActualModel, candidate.ActualPlatformId, ct, batch) != CatalogVerdict.Blocked)
                    {
                        kept.Add(candidate);
                        continue;
                    }
                    _logger.LogWarning(
                        "[ModelResolver] 重试候选不在名录且未放行（名录门={Gate}）: AppCallerCode={Code}, Model={Model}, PlatformId={PlatformId}",
                        _catalogGateEnforces ? "enforce/已摘除" : "observe/仍保留",
                        appCallerCode, candidate.ActualModel ?? "(空)", candidate.ActualPlatformId ?? "(空)");
                    if (!_catalogGateEnforces) kept.Add(candidate);
                }
                resolved.RetryCandidates = kept;
            }
            return resolved;
        }

        _logger.LogError(
            "[ModelResolver] 选中的模型不在内置名录且没有放行标记（名录门={Gate}）: "
            + "AppCallerCode={Code}, Model={Model}, PlatformId={PlatformId}, ResolutionType={Type}, Pool={Pool}",
            _catalogGateEnforces ? "enforce/已拒绝" : "observe/仅记录未拦截",
            appCallerCode,
            resolved.ActualModel ?? "(空)",
            resolved.ActualPlatformId ?? "(空)",
            resolved.ResolutionType,
            resolved.ModelGroupId ?? "(无)");

        // observe 档：日志已经把该点名的都点了，请求照常放行——这一档存在的意义就是
        // 「先看清存量有多少会被拦」，拦下来就看不成了。
        if (!_catalogGateEnforces) return resolved;

        return ModelResolutionResult.NotFound(
            resolved.ExpectedModel,
            $"模型「{resolved.ActualModel}」不在内置名录里，也没有被管理员显式放行；"
            + "正常从控制台导入的模型不会出现这种状态，请确认它是怎么进库的",
            GatewayRouteFailure.ModelNotInCatalog,
            "model-catalog",
            appCallerCode,
            modelPoolId: resolved.ModelGroupId);
    }

    /// <summary>
    /// 这道门对一次解析结果的三种裁决。
    ///
    /// 有「管不着」这一档，是因为门的判据只有一个来源：网关模型库里那条文档上的放行标记。
    /// 解析结果里的模型如果压根不是从那个库来的（主站自己的 legacy 模型、运维在主站配置或
    /// 环境变量里写死的应急兜底），库里就没有任何一条文档可查——**查不到不等于越界**。
    /// 把「查不到」和「查到了但没放行」混成一档，就会把运维亲手配的应急退路判死，
    /// 而那条退路恰恰是网关配置面出问题时唯一还能用的东西。
    ///
    /// 判据刻意问「这条模型是不是网关模型库里的」，而不是列一串 ResolutionType 字符串：
    /// 后者改个枚举名就悄悄失效，且每新增一条解析路径都得记得回来加一行（形状 1 / 形状 3）。
    /// </summary>
    private enum CatalogVerdict
    {
        /// <summary>名录内，或库里有放行标记。</summary>
        Allowed,
        /// <summary>是网关模型库里的模型，但既不在名录、也没有放行标记——这才是这道门要拦的。</summary>
        Blocked,
        /// <summary>不是网关模型库里的模型，这道门无从裁决。</summary>
        OutOfJurisdiction,
    }

    private async Task<CatalogVerdict> JudgeAsync(
        string? modelName,
        string? platformId,
        CancellationToken ct,
        IReadOnlyList<BsonDocument>? batch = null)
    {
        if (string.IsNullOrWhiteSpace(modelName)) return CatalogVerdict.OutOfJurisdiction;
        // 名录命中零额外开销（绝大多数请求走到这里就结束），只有名录外的才多一次带索引的读。
        if (GatewayModelCatalog.Contains(modelName)) return CatalogVerdict.Allowed;
        if (_gatewayDb is null) return CatalogVerdict.OutOfJurisdiction;

        var models = _gatewayDb.Context.Database.GetCollection<BsonDocument>("llmgw_models");
        var fb = Builders<BsonDocument>.Filter;
        var trimmed = modelName.Trim();
        // 两个名字字段都认：`ModelNameNormalized` 是控制台导入路径写的，但不是每条模型文档
        // 都有它（更早的写入、别的写入方只写了 ModelName）。只认归一化字段，那些文档就永远
        // 查不到、被判成「管不着」而放过去——同一个模型换个写法得到相反结论（形状 1）。
        // 知道是哪个 Provider 就把它写进谓词，**在 Limit 之前**收窄。
        // 先取 20 条再在内存里按 PlatformId 过滤，等于让「同名模型挂在几个 Provider 下」
        // 决定这道门的结论：同名文档超过 20 条时，那一页里可能根本没有当前这个 Provider 的记录，
        // 于是过滤后为空、判成「管不着」——没盖放行标记的模型反而被放过去（形状 1：
        // 判据取的是任意一页，不是它该管的那条）。
        var nameFilter = fb.And(
            fb.Eq("TenantId", CurrentTenantId),
            fb.Or(
                fb.Eq("ModelNameNormalized", trimmed.ToLowerInvariant()),
                fb.Eq("ModelName", trimmed)));
        var scopedFilter = string.IsNullOrWhiteSpace(platformId)
            ? nameFilter
            : fb.And(nameFilter, fb.Eq("PlatformId", platformId));
        // 预取拿到的是「这一批名字的全部文档」，按同一套口径在内存里收窄即可；
        // 预取不成立（超出上限、没有 db）就照旧单条查。**判据只有下面一处**，
        // 两条取值路径喂给它的是同形状的输入，不许各判各的。
        var docs = batch is not null
            ? SelectCatalogDocs(batch, trimmed, platformId)
            : await models.Find(scopedFilter).Limit(CatalogPairDocumentCap).ToListAsync(ct);

        if (docs.Count == 0)
        {
            // 走兑换所（exchange）解析出来的模型只活在兑换所文档里，llmgw_models 查不到它，
            // 于是会静默落进「管不着」——结果是放行，但那是**漏判**不是判断：
            // 下一个人读这段代码会以为这条路径本来就不在门的射程内。
            // 这里显式认出来，并且判的是**这一条别名**有没有被放行，不是「它是不是一条兑换所记录」。
            // 后者太宽：兑换所是个容器，认容器等于「进了这个门的都算放行」，往里加一个
            // 从没被人看过的别名照样过——那正是这道门要拦的形态，只是换了个集合。
            if (!string.IsNullOrWhiteSpace(platformId))
            {
                var exchangeVerdict = await JudgeExchangeModelAsync(platformId, trimmed, ct);
                if (exchangeVerdict is not null)
                {
                    _logger.LogDebug(
                        "[ModelResolver] 名录门：{Model} 来自兑换所 {ExchangeId}，判定 {Verdict}",
                        trimmed, platformId, exchangeVerdict);
                    return exchangeVerdict.Value;
                }
            }
            return CatalogVerdict.OutOfJurisdiction;
        }

        // 走到这里 docs 已经是「该管的那些」：给了 PlatformId 就只有那个 Provider 的，
        // 没给就是同名的全部（退回「任意一条放行过就算放行」）。
        return docs.Any(IsAllowedOutsideCatalog) ? CatalogVerdict.Allowed : CatalogVerdict.Blocked;
    }

    /// <summary>名录门一次判定的用量上限。超过它就退回逐条查——宁可慢，不拿一份被截断的清单下判断。</summary>
    private const int CatalogBatchDocumentCap = 2000;

    /// <summary>
    /// 单次判定（一个模型名 + 一个 Provider）最多看多少条文档。
    /// 两条取值路径必须用同一个上限：一边看 20 条、另一边看全部的话，
    /// 同一对输入会在两条路径上得到不同结论，而它们本该是同一个判据。
    /// </summary>
    private const int CatalogPairDocumentCap = 200;

    /// <summary>
    /// 把主选与整条重试链要用到的模型文档一次取回。
    ///
    /// 只为省往返，不改判据：返回的是「这一批名字在本租户下的全部文档」，
    /// 收窄到某个 Provider 由 <see cref="SelectCatalogDocs"/> 按与单条查询同一套口径做。
    /// 名录内的模型不进这一批（<see cref="JudgeAsync"/> 开头就放行了），所以常见请求这里是空转。
    ///
    /// 取不满或超上限时返回 null，调用方照旧逐条查——**一份被截断的清单不能拿来下判断**：
    /// 那正是这道门此前栽过的形状（判据取的是任意一页，不是它该管的那条）。
    /// </summary>
    private async Task<IReadOnlyList<BsonDocument>?> PrefetchCatalogDocsAsync(
        IReadOnlyList<ModelResolutionResult> targets,
        CancellationToken ct)
    {
        if (_gatewayDb is null) return null;
        var names = targets
            .Select(target => target.ActualModel?.Trim() ?? string.Empty)
            .Where(name => name.Length > 0 && !GatewayModelCatalog.Contains(name))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        // 一两条的时候批量查没有意义，直接让它走单条路径，少一个分支要维护。
        if (names.Count < 2) return null;

        var fb = Builders<BsonDocument>.Filter;
        var docs = await _gatewayDb.Context.Database.GetCollection<BsonDocument>("llmgw_models")
            .Find(fb.And(
                fb.Eq("TenantId", CurrentTenantId),
                fb.Or(
                    fb.In("ModelNameNormalized", names.Select(name => name.ToLowerInvariant())),
                    fb.In("ModelName", names))))
            .Limit(CatalogBatchDocumentCap + 1)
            .ToListAsync(ct);
        return docs.Count > CatalogBatchDocumentCap ? null : docs;
    }

    /// <summary>
    /// 从预取结果里挑出「这一条该管的那些」：两个名字字段都认、给了 Provider 就只留那个 Provider 的。
    /// 与单条查询的谓词逐字对应，改一边就要改另一边——这也是它紧挨着放的原因。
    /// </summary>
    private static List<BsonDocument> SelectCatalogDocs(
        IReadOnlyList<BsonDocument> batch,
        string modelName,
        string? platformId)
    {
        var normalized = modelName.ToLowerInvariant();
        return batch.Where(doc =>
        {
            var matchesName = Text(doc, "ModelNameNormalized") == normalized || Text(doc, "ModelName") == modelName;
            if (!matchesName) return false;
            return string.IsNullOrWhiteSpace(platformId) || Text(doc, "PlatformId") == platformId;
        }).Take(CatalogPairDocumentCap).ToList();

        // 字段不是字符串（历史脏数据）时当成空串，而不是抛——判据在请求路径上，
        // 一条坏文档不该让整次调用炸掉。
        static string Text(BsonDocument doc, string field)
            => doc.TryGetValue(field, out var value) && value.IsString ? value.AsString : string.Empty;
    }

    /// <summary>
    /// 这条模型是兑换所里的吗？是的话它该不该放行？
    ///
    /// 兑换所解析会把 PlatformId 写成兑换所自己的 id（<c>item.PlatformId = exchange.Id</c>），
    /// 所以按 id 查得到就说明这条模型来自兑换所。但「来自兑换所」只回答了管辖问题，
    /// 放行与否要看**这一条别名**：走到这里的一定是名录外的（名录内的在方法开头就放行了），
    /// 所以它必须带着控制台写入时盖的 per-model 放行标记（谁放的、什么时候），
    /// 与手工新增模型那道门同一套依据。
    ///
    /// 返回 null 表示「这个 PlatformId 不是兑换所」——那是管辖之外，交回上层按原样处理。
    /// </summary>
    private async Task<CatalogVerdict?> JudgeExchangeModelAsync(string platformId, string modelId, CancellationToken ct)
    {
        if (_gatewayDb is null) return null;
        var exchanges = _gatewayDb.Context.Database.GetCollection<BsonDocument>("llmgw_model_exchanges");
        var fb = Builders<BsonDocument>.Filter;
        var exchange = await exchanges
            .Find(fb.And(fb.Eq("TenantId", CurrentTenantId), fb.Eq("_id", platformId)))
            .FirstOrDefaultAsync(ct);
        if (exchange is null) return null;

        // 兑换所里没有这条别名 = 它不是这个兑换所声明过的东西，一律拦下。
        // （解析器正常走下来不该出现这种情况；出现了说明有人在别处拼了个 PlatformId。）
        var declared = exchange.TryGetValue("Models", out var raw) && raw is BsonArray array
            ? array.OfType<BsonDocument>().FirstOrDefault(item =>
                string.Equals(item.GetValue("ModelId", string.Empty).AsString, modelId, StringComparison.OrdinalIgnoreCase))
            : null;
        if (declared is null) return CatalogVerdict.Blocked;

        // 名录内的在方法开头就放行了，走到这里的一定是名录外的：所以只看放行标记。
        // （不在这里再判一次名录——那一档永远为假，读的人会以为它在起作用。）
        return declared.TryGetValue("AllowedOutsideCatalog", out var allowed) && allowed.IsBoolean && allowed.AsBoolean
            ? CatalogVerdict.Allowed
            : CatalogVerdict.Blocked;
    }

    private static bool IsAllowedOutsideCatalog(BsonDocument doc)
        => doc.TryGetValue("AllowedOutsideCatalog", out var value) && value.IsBoolean && value.AsBoolean;

    private async Task<ModelResolutionResult> ResolveCoreAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null,
        CancellationToken ct = default)
    {
        var plan = new ModelResolutionPlan
        {
            AppCallerCode = appCallerCode,
            ModelType = modelType,
            ExpectedModel = expectedModel
        };

        List<ModelGroup>? candidateGroups = null;
        var hasDedicatedBinding = false;
        string resolutionType = "NotFound";

        var gatewayConfigRequired = !string.Equals(CurrentTenantId, _internalTenantId, StringComparison.Ordinal)
                                    || DisableMapConfigFallbackForRegisteredAppCallers();
        var gatewayRegistry = await TryGetGatewayRegistryGroupsAsync(appCallerCode, modelType, ct);
        if (gatewayRegistry.TrafficRejected)
        {
            _logger.LogWarning(
                "[ModelResolver] GW appCaller 状态拒绝真实流量: AppCallerCode={Code}, ModelType={Type}, Status={Status}, Reason={Reason}",
                appCallerCode,
                modelType,
                gatewayRegistry.Status ?? "missing",
                gatewayRegistry.BlockReason ?? "appcaller-traffic-rejected");
            return ModelResolutionResult.NotFound(expectedModel,
                $"GW appCaller 状态不允许真实流量: AppCallerCode={appCallerCode}, ModelType={modelType}, Status={gatewayRegistry.Status ?? "missing"}",
                GatewayRouteFailure.AppCallerPoolUnbound,
                "appcaller-registry-status",
                appCallerCode,
                modelPoolId: gatewayRegistry.ModelPoolId);
        }

        // MAP appCaller 只属于兼容 fallback。配置权威开启后不触碰 MAP 配置集合，
        // 因此 MAP 配置域故障不会阻断 GW-owned 路由。
        LLMAppCaller? appCaller = null;
        if (!gatewayConfigRequired)
        {
            appCaller = await _db.LLMAppCallers
                .Find(a => a.AppCode == appCallerCode)
                .FirstOrDefaultAsync(ct);
        }

        // 旧 AppCaller 在迁移完成前保留逻辑模型目录兼容路径。新 AppCaller 一旦写入
        // AllowedModelPoolIds 就启用严格模型池契约，逻辑模型不得越过该边界。
        if (!gatewayRegistry.StrictPoolContract
            && string.IsNullOrWhiteSpace(pinnedPlatformId)
            && string.IsNullOrWhiteSpace(pinnedModelId))
        {
            var logical = await TryResolveLogicalModelAsync(appCallerCode, modelType, expectedModel, ct);
            if (logical is not null)
                return logical;
        }

        if (gatewayRegistry.Groups.Count == 0 && gatewayConfigRequired)
        {
            _logger.LogWarning(
                "[ModelResolver] GW appCaller 禁止 MAP fallback，但未命中有效 GW 模型池: AppCallerCode={Code}, ModelType={Type}, Status={Status}, ModelPoolId={PoolId}, Reason={Reason}",
                appCallerCode, modelType, gatewayRegistry.Status ?? "missing",
                gatewayRegistry.ModelPoolId ?? "(未绑定)", gatewayRegistry.BlockReason ?? "missing-gateway-pool");
            // 配置面「读不到」与配置「配错了」必须分开：前者是基础设施故障（重试可能恢复），
            // 后者是配置问题（重试无用）。混成一个码会让配置库抖动被误判成全站模型池报废。
            return ModelResolutionResult.NotFound(expectedModel,
                $"GW appCaller 未绑定有效 GW 模型池，已禁止 MAP fallback: AppCallerCode={appCallerCode}, ModelType={modelType}, Status={gatewayRegistry.Status ?? "missing"}",
                gatewayRegistry.ConfigPlaneUnavailable
                    ? GatewayRouteFailure.GatewayConfigUnavailable
                    : GatewayRouteFailure.AppCallerPoolUnbound,
                gatewayRegistry.ConfigPlaneUnavailable ? "gateway-config-plane" : "appcaller-registry-binding",
                appCallerCode,
                modelPoolId: gatewayRegistry.ModelPoolId);
        }

        // pinned 是精确模型语义，但不能越过 appCaller 的专用池治理边界。
        // model_policy=pool 会把用户选中的池写入 ExpectedModel；保留这份池身份，
        // 因为下面为了精确 Provider 匹配会把 ExpectedModel 改成 PinnedModelId。
        var requestedPoolIdentity = expectedModel?.Trim();
        if (gatewayRegistry.Groups.Count > 0
            && (!string.IsNullOrWhiteSpace(pinnedPlatformId) || !string.IsNullOrWhiteSpace(pinnedModelId)))
        {
            var requestedPool = gatewayRegistry.StrictPoolContract && !string.IsNullOrWhiteSpace(requestedPoolIdentity)
                ? gatewayRegistry.Groups.FirstOrDefault(group =>
                    string.Equals(group.Id, requestedPoolIdentity, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(group.Code, requestedPoolIdentity, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(group.Name, requestedPoolIdentity, StringComparison.OrdinalIgnoreCase))
                : null;

            // GatewayIngressRequest 在 model_policy=pool 时把池身份写入 ExpectedModel；
            // 精确 Provider 路由则通常把 ExpectedModel 设为同一个 PinnedModelId。
            // 严格契约下，带 pin 的未知池身份不能降级成“任意允许池”，否则会绕过用户的池选择。
            var looksLikeExplicitPoolSelection = !string.IsNullOrWhiteSpace(requestedPoolIdentity)
                && !string.Equals(requestedPoolIdentity, pinnedModelId?.Trim(), StringComparison.OrdinalIgnoreCase);
            if (gatewayRegistry.StrictPoolContract
                && looksLikeExplicitPoolSelection
                && requestedPool is null)
            {
                return ModelResolutionResult.NotFound(
                    requestedPoolIdentity,
                    $"所选模型池不在 appCaller 允许范围内: AppCallerCode={appCallerCode}, ModelType={modelType}, ModelPool={requestedPoolIdentity}",
                    GatewayRouteFailure.RouteConfigIncompatible,
                    "pinned-pool-contract",
                    appCallerCode,
                    modelPoolId: requestedPoolIdentity);
            }

            var pinnedScope = requestedPool is null ? gatewayRegistry.Groups : [requestedPool];
            var pinnedTarget = !string.IsNullOrWhiteSpace(pinnedPlatformId)
                               && !string.IsNullOrWhiteSpace(pinnedModelId)
                ? pinnedScope
                    .SelectMany(group => group.Models.Select(model => (Group: group, Model: model)))
                    .FirstOrDefault(candidate =>
                        string.Equals(candidate.Model.PlatformId, pinnedPlatformId.Trim(), StringComparison.Ordinal)
                        && string.Equals(candidate.Model.ModelId, pinnedModelId.Trim(), StringComparison.Ordinal))
                : default;
            if (pinnedTarget.Model is null)
            {
                return ModelResolutionResult.NotFound(
                    expectedModel ?? pinnedModelId,
                    $"PinnedModel 不在 appCaller 专用模型池内: AppCallerCode={appCallerCode}, ModelType={modelType}",
                    GatewayRouteFailure.RouteConfigIncompatible,
                    "pinned-pool-member",
                    appCallerCode,
                    modelPoolId: requestedPoolIdentity);
            }
            // compute-then-send 的第二次解析必须真正锁定第一次选中的物理模型。
            // 过去这里只把 expectedModel 改成模型名，随后仍进入模型池健康调度；当 MAP 与
            // serving 的健康快照不一致时，serving 会把已锁定的 gpt-audio 重新选成
            // gpt-4o-transcribe，却继续沿用前者构造的 chat-audio 请求，最终把转写模型发到
            // /v1/chat/completions。治理边界已由上面的池成员匹配完成，此处应直接
            // 解析该平台与模型，找不到就失败关闭，绝不能静默换成池内另一个成员。
            return await ResolvePinnedGatewayPoolMemberAsync(
                appCallerCode,
                pinnedTarget.Group,
                pinnedTarget.Model,
                pinnedModelId,
                ct);
        }
        if (!string.IsNullOrWhiteSpace(pinnedPlatformId) || !string.IsNullOrWhiteSpace(pinnedModelId))
        {
            var pinned = await TryResolvePinnedModelAsync(
                appCallerCode,
                expectedModel,
                pinnedPlatformId,
                pinnedModelId,
                ct,
                allowMapFallback: !gatewayConfigRequired);
            if (pinned != null)
            {
                return pinned;
            }
        }

        if (gatewayRegistry.Groups.Count > 0)
        {
            candidateGroups = gatewayRegistry.Groups;
            if (gatewayRegistry.StrictPoolContract)
            {
                var requestedPool = string.IsNullOrWhiteSpace(expectedModel)
                    ? gatewayRegistry.DefaultModelPoolId
                    : expectedModel.Trim();
                var strictCandidates = SelectStrictPoolCandidates(
                    candidateGroups,
                    requestedPool,
                    gatewayRegistry.AllowCrossPoolFallback);
                if (strictCandidates.Count == 0)
                {
                    return ModelResolutionResult.NotFound(expectedModel,
                        $"所选模型池不在 appCaller 允许范围内: AppCallerCode={appCallerCode}, ModelType={modelType}, ModelPool={requestedPool ?? "(未指定)"}",
                        GatewayRouteFailure.RouteConfigIncompatible,
                        "strict-pool-contract",
                        appCallerCode,
                        modelPoolId: requestedPool);
                }

                candidateGroups = strictCandidates;
                expectedModel = null;
            }
            resolutionType = "GatewayRegistryPool";
            hasDedicatedBinding = true;
            _logger.LogInformation(
                "[ModelResolver] 使用 GW appCaller 模型池: AppCallerCode={Code}, Status={Status}, PoolCount={Count}, PoolNames={Names}",
                appCallerCode, gatewayRegistry.Status ?? "unknown",
                candidateGroups.Count,
                string.Join(", ", candidateGroups.Select(g => g.Name)));
        }

        if ((candidateGroups == null || candidateGroups.Count == 0) && appCaller == null)
        {
            _logger.LogWarning(
                "[ModelResolver] AppCallerCode 未在 MAP/GW 中配置: {Code}，请在 GW 控制台激活或在 MAP 管理后台初始化应用",
                appCallerCode);
            return ModelResolutionResult.NotFound(expectedModel,
                $"AppCallerCode '{appCallerCode}' 未在 MAP/GW 中配置，请在 GW 控制台激活或在 MAP 管理后台初始化应用",
                GatewayRouteFailure.AppCallerPoolUnbound,
                "appcaller-registry-missing",
                appCallerCode);
        }

        if ((candidateGroups == null || candidateGroups.Count == 0) && appCaller != null)
        {
            var requirement = appCaller.ModelRequirements
                .FirstOrDefault(r => r.ModelType == modelType);
            var modelGroupIds = requirement?.ModelGroupIds;

            if (HasDedicatedBinding(requirement?.ModelGroupIds))
            {
                // 绑定看配置、不看查询结果，判据见 HasDedicatedBinding 的注释。
                hasDedicatedBinding = true;

                // ========== 第二步：查找专属模型池 ==========
                candidateGroups = await _db.ModelGroups
                    .Find(g => modelGroupIds!.Contains(g.Id))
                    .SortBy(g => g.Priority)
                    .ToListAsync(ct);

                if (candidateGroups.Count > 0)
                {
                    resolutionType = "DedicatedPool";
                    _logger.LogDebug(
                        "[ModelResolver] 找到专属模型池: AppCallerCode={Code}, PoolCount={Count}, PoolNames={Names}",
                        appCallerCode, candidateGroups.Count,
                        string.Join(", ", candidateGroups.Select(g => g.Name)));
                }
            }
        }

        // ========== 第三步：回退到默认模型池 ==========
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            candidateGroups = await _db.ModelGroups
                .Find(g => g.ModelType == modelType && g.IsDefaultForType)
                .SortBy(g => g.Priority)
                .ToListAsync(ct);

            if (candidateGroups.Count > 0)
            {
                resolutionType = "DefaultPool";
                _logger.LogDebug(
                    "[ModelResolver] 使用默认模型池: ModelType={Type}, PoolCount={Count}, PoolNames={Names}",
                    modelType, candidateGroups.Count,
                string.Join(", ", candidateGroups.Select(g => g.Name)));
            }
        }

        // 池解析完成后的重试会携带 ModelGroupId 作为 expectedModel。即使是旧的
        // MAP 兼容路径，也必须把池 ID 解释为“锁定该池”，不能退回按优先级重新选池，
        // 否则同一个 Run 的第二次 resolve 可能漂移到另一个池。
        if (!string.IsNullOrWhiteSpace(expectedModel)
            && !string.Equals(resolutionType, "GatewayRegistryPool", StringComparison.Ordinal)
            && candidateGroups is { Count: > 0 })
        {
            var poolCandidates = candidateGroups;
            var requestedPool = poolCandidates.FirstOrDefault(group =>
                string.Equals(group.Id, expectedModel.Trim(), StringComparison.OrdinalIgnoreCase)
                || string.Equals(group.Code, expectedModel.Trim(), StringComparison.OrdinalIgnoreCase)
                || string.Equals(group.Name, expectedModel.Trim(), StringComparison.OrdinalIgnoreCase));
            if (requestedPool is not null)
            {
                candidateGroups = [requestedPool];
                expectedModel = null;
            }
        }

        // ========== 第五步：无 dedicated/default 池 → legacy 直连兜底 ==========
        // 未迁移到 ModelGroups 的部署仍可能有 IsMain/IsIntent/IsVision/IsImageGen 标记的 enabled 模型、
        // 但无默认池。直接 NotFound 会让这类部署全链解析失败（Codex P1）。NotFound 前先查 legacy 直连，
        // 迁移自动化前保留向后兼容；已迁移部署有池故不会走到这里，零影响。
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            var legacyModel = await FindLegacyModelAsync(modelType, ct);
            if (legacyModel != null)
            {
                var legacyPlatform = await _db.LLMPlatforms
                    .Find(p => p.Id == legacyModel.PlatformId && p.Enabled)
                    .FirstOrDefaultAsync(ct);
                if (legacyPlatform != null)
                {
                    var legacyApiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(legacyPlatform.ApiKeyEncrypted, _config);
                    _logger.LogInformation(
                        "[ModelResolver] 无池，使用 legacy 直连模型: ModelType={Type}, Model={Model}, Platform={Platform}",
                        modelType, legacyModel.ModelName, legacyPlatform.Name);
                    return ModelResolutionResult.FromLegacy(expectedModel, legacyModel, legacyPlatform, legacyApiKey);
                }
            }

            var legacyConfig = await TryResolveLegacyConfigFallbackAsync(modelType, expectedModel, ct);
            if (legacyConfig != null)
            {
                return legacyConfig;
            }

            _logger.LogWarning(
                "[ModelResolver] 未找到可用模型（无池且 legacy 未命中）: AppCallerCode={Code}, ModelType={Type}",
                appCallerCode, modelType);

            return ModelResolutionResult.NotFound(expectedModel,
                $"未找到可用模型: AppCallerCode={appCallerCode}, ModelType={modelType}",
                GatewayRouteFailure.ModelPoolEmpty,
                "pool-candidates-empty",
                appCallerCode);
        }

        // ========== 第 5.5 步：旧契约若调用方指定了 expectedModel，优先尊重 ==========
        // 搜索顺序（广度递增）：
        //   1. 候选池（AppCaller 绑定的池）
        //   2. 该 ModelType 下的所有池（AppCaller 未绑定但平台有配置的池）
        //   3. LLMModels 直连（既不在任何池也可以按 ModelName 查到的单模型）
        // 前两档命中都会把匹配到的池加入 candidateGroups 头部；第三档直接返回 Legacy 结果。
        ModelGroup? preferredGroup = null;
        ModelGroupItem? preferredItem = null;
        if (!string.IsNullOrWhiteSpace(expectedModel))
        {
            // 档 1：候选池
            var (g, m) = FindPreferredModel(candidateGroups, expectedModel);
            if (g != null && m != null)
            {
                preferredGroup = g;
                preferredItem = m;
                _logger.LogInformation(
                    "[ModelResolver] 命中 expectedModel（候选池）: {Expected} → 池 {PoolName} 中的模型 {ModelId}",
                    expectedModel, g.Name, m.ModelId);
            }
            else
            {
                // 档 2：该 ModelType 下的所有池（包括未绑定到 AppCaller 的）
                if (gatewayConfigRequired)
                {
                    _logger.LogInformation(
                            "[ModelResolver] GW appCaller 已禁止 MAP fallback，跳过 expectedModel 的 MAP 全量池搜索: AppCallerCode={Code}, Expected={Expected}",
                        appCallerCode, expectedModel);
                }
                else
                {
                    var allTypeGroups = await _db.ModelGroups
                        .Find(x => x.ModelType == modelType)
                        .ToListAsync(ct);
                    var knownIds = candidateGroups.Select(x => x.Id).ToHashSet();
                    var extraGroups = allTypeGroups.Where(x => !knownIds.Contains(x.Id)).ToList();
                    if (extraGroups.Count > 0)
                    {
                        var (g2, m2) = FindPreferredModel(extraGroups, expectedModel);
                        if (g2 != null && m2 != null)
                        {
                            preferredGroup = g2;
                            preferredItem = m2;
                            candidateGroups.Insert(0, g2); // 纳入主循环以便走统一的 Exchange / Platform 解析路径
                            resolutionType = "DirectModel"; // 越出 AppCaller 绑定范围 → 直连语义
                            _logger.LogInformation(
                                "[ModelResolver] 命中 expectedModel（全量池兜底）: {Expected} → 池 {PoolName} 中的模型 {ModelId}",
                                expectedModel, g2.Name, m2.ModelId);
                        }
                    }
                }

                // 档 3：LLMModels 直连（按 ModelName 查）
                if (preferredGroup == null)
                {
                    if (gatewayConfigRequired)
                    {
                        _logger.LogInformation(
                                "[ModelResolver] GW appCaller 已禁止 MAP fallback，跳过 expectedModel 的 LLMModels 直连兜底: AppCallerCode={Code}, Expected={Expected}",
                            appCallerCode, expectedModel);
                    }
                    else if (hasDedicatedBinding && ShouldFailClosedWhenDedicatedPoolUnavailable(modelType))
                    {
                        _logger.LogInformation(
                            "[ModelResolver] {ModelType} 已绑定专属模型池，跳过 expectedModel 的 LLMModels 直连兜底: AppCallerCode={Code}, Expected={Expected}",
                            modelType, appCallerCode, expectedModel);
                    }
                    else
                    {
                        var direct = await _db.LLMModels
                            .Find(x => x.Enabled && x.ModelName == expectedModel.Trim())
                            .FirstOrDefaultAsync(ct);
                        if (direct != null)
                        {
                            var platform = await _db.LLMPlatforms
                                .Find(p => p.Id == direct.PlatformId && p.Enabled)
                                .FirstOrDefaultAsync(ct);
                            if (platform != null)
                            {
                                var apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(platform.ApiKeyEncrypted, _config);
                                _logger.LogInformation(
                                    "[ModelResolver] 命中 expectedModel（LLMModels 直连）: {Expected} → platform={Platform}",
                                    expectedModel, platform.Name);
                                return ModelResolutionResult.FromLegacy(expectedModel, direct, platform, apiKey);
                            }
                        }
                    }

                    _logger.LogInformation(
                        "[ModelResolver] expectedModel '{Expected}' 在所有池和 LLMModels 都未找到匹配，将走默认调度（候选池：[{Pools}]）",
                        expectedModel, string.Join(", ", candidateGroups.Select(x => x.Name)));
                }
            }
        }

        // ========== 第六步：从模型池中选择最佳模型 ==========
        // 若上一步命中 expectedModel，将该池放在最前面优先尝试
        var orderedGroups = preferredGroup != null
            ? new[] { preferredGroup }.Concat(candidateGroups.Where(g => g.Id != preferredGroup.Id)).ToList()
            : candidateGroups;

        var resolvedPoolCandidates = new List<ModelResolutionResult>();
        var allowProviderRetryCandidates = string.IsNullOrWhiteSpace(expectedModel);

        foreach (var group in orderedGroups)
        {
            // 诊断：模型池内容
            _logger.LogInformation(
                "[ModelResolver] 检查模型池 {PoolName}: 模型数={Count}, 模型列表=[{Models}]",
                group.Name,
                group.Models?.Count ?? 0,
                string.Join(", ", group.Models?.Select(m =>
                    $"{m.ModelId}(Health={m.HealthStatus}, Platform={m.PlatformId})") ?? Array.Empty<string>()));

            // expectedModel 命中的池：直接用命中的具体条目；否则按健康度选可用候选。
            // auto 模式下保留完整候选序列，发送阶段可在可重试失败后换下一个候选；
            // 用户明确 expectedModel/pinned 时不得换模型，避免“选 A 发 B”。
            var selectedModels = (preferredGroup != null && group.Id == preferredGroup.Id)
                ? (preferredItem is null ? [] : new List<ModelGroupItem> { preferredItem })
                : await SelectProviderRetryCandidatesAsync(
                    group,
                    allowProviderRetryCandidates,
                    gatewayOwned: string.Equals(resolutionType, "GatewayRegistryPool", StringComparison.Ordinal),
                    ct);
            if (selectedModels.Count == 0)
            {
                _logger.LogWarning(
                    "[ModelResolver] 模型池 {PoolName} 中无可用模型（全部 Unavailable 或为空）",
                    group.Name);
                continue;
            }

            // ========== Exchange 中继检测 ==========
            // 模型池中的 Exchange 条目有两种可能的 PlatformId：
            //   A) "__exchange__"（旧数据，legacy virtual platform id）
            //      → 按 ModelId 去 ModelExchanges 里找匹配 ModelAlias / ModelAliases / Models[].ModelId 的
            //   B) 真实 Exchange.Id（新数据，虚拟平台作为一等公民）
            //      → 按 Id 直接查 ModelExchange
            // 找到 Exchange 则走中继路径；找不到则降级到下面的普通平台分支。
            foreach (var selectedModel in selectedModels)
            {
                ModelExchange? exchange = await FindExchangeForPoolItemAsync(
                    selectedModel,
                    allowMapFallback: !gatewayConfigRequired,
                    ct);

                if (exchange != null)
                {
                    var exchangeApiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(exchange.TargetApiKeyEncrypted, _config);

                    _logger.LogInformation(
                        "[ModelResolver] Exchange 中继候选已解析\n" +
                        "  AppCallerCode: {AppCallerCode}\n" +
                        "  ResolutionType: {ResolutionType}\n" +
                        "  ModelGroup: {GroupName} ({GroupId})\n" +
                        "  Exchange: {ExchangeName} ({ExchangeId})\n" +
                        "  ModelId: {ModelId}\n" +
                        "  TargetUrl: {TargetUrl}\n" +
                        "  Transformer: {Transformer}",
                        appCallerCode, resolutionType, group.Name, group.Id,
                        exchange.Name, exchange.Id,
                        selectedModel.ModelId, exchange.TargetUrl, exchange.TransformerType);

                    resolvedPoolCandidates.Add(ModelResolutionResult.FromExchangePool(
                        resolutionType, expectedModel, selectedModel, group, exchange, exchangeApiKey));
                    if (!allowProviderRetryCandidates)
                        return resolvedPoolCandidates[0];
                    continue;
                }

                // 若 PlatformId 是 "__exchange__" 但找不到匹配 Exchange，记录后跳过
                if (selectedModel.PlatformId == ModelResolverConstants.ExchangePlatformId)
                {
                    _logger.LogWarning(
                        "[ModelResolver] Exchange 配置未找到或已禁用: ModelId={ModelId}",
                        selectedModel.ModelId);
                    continue;
                }

                // ========== 普通平台模型 ==========
                var platform = await FindGatewayOwnedOrMapPlatformAsync(
                    selectedModel.PlatformId,
                    enabledOnly: true,
                    ct,
                    allowMapFallback: !gatewayConfigRequired);

                if (platform == null)
                {
                    // 诊断：平台查找失败
                    var platformById = await FindGatewayOwnedOrMapPlatformAsync(
                        selectedModel.PlatformId,
                        enabledOnly: false,
                        ct,
                        allowMapFallback: !gatewayConfigRequired);

                    _logger.LogWarning(
                        "[ModelResolver] 模型池 {PoolName} 中的模型 {ModelId} 平台不可用: PlatformId={PlatformId}, Exists={Exists}, Enabled={Enabled}",
                        group.Name, selectedModel.ModelId, selectedModel.PlatformId,
                        platformById != null, platformById?.Enabled);
                    continue;
                }

                var apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(platform.ApiKeyEncrypted, _config);

                _logger.LogInformation(
                    "[ModelResolver] 调度候选已解析\n" +
                    "  AppCallerCode: {AppCallerCode}\n" +
                    "  ResolutionType: {ResolutionType}\n" +
                    "  ModelGroup: {GroupName} ({GroupId})\n" +
                    "  ExpectedModel: {Expected}\n" +
                    "  ActualModel: {Actual}\n" +
                    "  Platform: {Platform}\n" +
                    "  HealthStatus: {Health}",
                    appCallerCode, resolutionType, group.Name, group.Id,
                    expectedModel ?? "(无)", selectedModel.ModelId,
                    platform.Name, selectedModel.HealthStatus);

                // 并发治理需要真实模型级 MaxConcurrency；能力/协议字段仍沿用池快照优先级。
                var modelConfig = await FindGatewayOwnedOrMapModelAsync(
                    selectedModel.PlatformId,
                    selectedModel.ModelId,
                    ct,
                    allowMapFallback: !gatewayConfigRequired);

                // 上面这次查找本来就带 Enabled==true，却只把结果当 MaxConcurrency 的来源，
                // 空值直接丢掉——于是「模型已停用」这个它明明查得到的事实从来没被用上：
                // 平台停用会被 platform==null 挡下，模型停用却照发不误。
                //
                // 后果不只是少一道闸。托管默认池是 append-only（成员删不掉、也不许覆盖），
                // 加成员时又有 MODEL_DISABLED 拦着「停用模型不许进池」；两条规矩合起来，
                // 池里一旦混进一个不可调用的条目（批量导入很容易），控制台就再没有任何
                // 一条路能让它别再被选中——停用模型是唯一剩下的动作，而它在这里没效果。
                //
                // 判据只认「库里明写着 Enabled=false」这一种证据：查不到不算（可能是纯池
                // 快照成员、跨租户、或 MAP fallback 被关掉），字段缺失也不算（Mongo 的
                // Eq(false) 不匹配缺字段的文档，正好挡住把「老数据没写这个字段」误判成停用）。
                // 这道闸**不能**拿 `modelConfig is null` 当前置条件。上面那次查找开着 MAP
                // 兜底：GW 里这条模型明写着 Enabled=false，它会跳过、转而捞出 MAP 里那份还
                // 启用着的旧副本，于是 modelConfig 非空、闸门整条被短路——运维在网关里点了
                // 停用，模型照发。判据本身没写错，错在拿一个「找到了可用配置」的结果去证明
                // 「它没被停用」，而这两件事有两个数据源时并不等价。
                //
                // 反过来也要防：GW 里启用着、MAP 里躺着一份过期的停用副本时，不能被误判成
                // 停用。所以 MAP 侧的停用记录只在「GW 压根没有权威记录」（modelConfig 为空）
                // 时才算数；GW 有话说的时候一律以 GW 为准。
                if (await IsPoolMemberModelExplicitlyDisabledAsync(
                        selectedModel.PlatformId,
                        selectedModel.ModelId,
                        ct,
                        allowMapFallback: !gatewayConfigRequired && modelConfig is null))
                {
                    _logger.LogWarning(
                        "[ModelResolver] 模型池 {PoolName} 中的模型 {ModelId} 已停用，跳过该候选: PlatformId={PlatformId}",
                        group.Name, selectedModel.ModelId, selectedModel.PlatformId);
                    continue;
                }

                resolvedPoolCandidates.Add(ModelResolutionResult.FromPool(
                    resolutionType, expectedModel, selectedModel, group, platform, apiKey, modelConfig));
                if (!allowProviderRetryCandidates)
                    return resolvedPoolCandidates[0];
            }
        }

        if (resolvedPoolCandidates.Count > 0)
        {
            var selected = resolvedPoolCandidates[0];
            if (resolvedPoolCandidates.Count > 1)
                selected.RetryCandidates = resolvedPoolCandidates.Skip(1).ToList();
            _logger.LogInformation(
                "[ModelResolver] 调度完成: AppCallerCode={AppCallerCode}, Selected={Model}, RetryCandidates={RetryCount}",
                appCallerCode, selected.ActualModel, selected.RetryCandidates?.Count ?? 0);
            return selected;
        }

        // ========== 第七步：模型池全部不可用 → legacy 直连降级 ==========
        // 池存在但池内模型全部 Unavailable 时，未迁移部署仍可降级到 legacy 直连（Codex P1）。
        // 收集原始模型池状态用于诊断 + 降级结果的 OriginalModels 字段。
        var originalPool = candidateGroups.FirstOrDefault();
        // 「池是空的」和「成员全熔断」是两种处置动作：前者要去补成员，后者要去看上游。
        // 合成一个错误码，管理员就只能从零复现——这正是本次事故里最贵的部分。
        var poolFailureCode = candidateGroups.All(g => (g.Models?.Count ?? 0) == 0)
            ? GatewayRouteFailure.ModelPoolEmpty
            : GatewayRouteFailure.ModelPoolAllUnavailable;
        var poolFailureStage = poolFailureCode == GatewayRouteFailure.ModelPoolEmpty
            ? "pool-membership"
            : "pool-health";
        var originalModels = originalPool?.Models?.Select(m => new OriginalModelInfo
        {
            ModelId = m.ModelId,
            PlatformId = m.PlatformId,
            HealthStatus = m.HealthStatus.ToString(),
            IsAvailable = m.HealthStatus != ModelHealthStatus.Unavailable,
            ConsecutiveFailures = m.ConsecutiveFailures
        }).ToList();

        if (gatewayConfigRequired)
        {
            _logger.LogWarning(
                "[ModelResolver] GW appCaller 模型池全部不可用，拒绝降级 MAP legacy: AppCallerCode={Code}, ModelType={Type}, Pool={Pool}",
                appCallerCode, modelType, originalPool?.Name);
            return ModelResolutionResult.NotFound(expectedModel,
                $"GW appCaller 模型池不可用，已禁止 MAP fallback: AppCallerCode={appCallerCode}, ModelType={modelType}",
                poolFailureCode,
                poolFailureStage,
                appCallerCode,
                modelPoolId: originalPool?.Id);
        }

        if (hasDedicatedBinding && ModelResolver.ShouldFailClosedWhenDedicatedPoolUnavailable(modelType))
        {
            _logger.LogWarning(
                "[ModelResolver] {ModelType} 专属模型池全部不可用，拒绝降级 legacy 直连: AppCallerCode={Code}, Pool={Pool}",
                modelType, appCallerCode, originalPool?.Name);
            return ModelResolutionResult.NotFound(expectedModel,
                $"模型池内所有模型不可用: AppCallerCode={appCallerCode}, ModelType={modelType}",
                poolFailureCode,
                poolFailureStage,
                appCallerCode,
                modelPoolId: originalPool?.Id);
        }

        var fallbackLegacyModel = await FindLegacyModelAsync(modelType, ct);
        if (fallbackLegacyModel != null)
        {
            var fallbackPlatform = await _db.LLMPlatforms
                .Find(p => p.Id == fallbackLegacyModel.PlatformId && p.Enabled)
                .FirstOrDefaultAsync(ct);
            if (fallbackPlatform != null)
            {
                var fallbackApiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(fallbackPlatform.ApiKeyEncrypted, _config);
                _logger.LogWarning(
                    "[ModelResolver] 池内全部不可用，降级 legacy 直连: Model={Model} @ {Platform}",
                    fallbackLegacyModel.ModelName, fallbackPlatform.Name);
                return new ModelResolutionResult
                {
                    Success = true,
                    ResolutionType = "Legacy",
                    ExpectedModel = expectedModel,
                    ActualModel = fallbackLegacyModel.ModelName,
                    ActualPlatformId = fallbackLegacyModel.PlatformId ?? string.Empty,
                    ActualPlatformName = fallbackPlatform.Name,
                    PlatformType = fallbackPlatform.PlatformType,
                    ApiUrl = fallbackLegacyModel.ApiUrl ?? fallbackPlatform.ApiUrl,
                    ApiKey = fallbackApiKey,
                    HealthStatus = "Healthy",
                    MaxTokens = fallbackLegacyModel.MaxTokens,
                    PlatformMaxConcurrency = fallbackPlatform.MaxConcurrency,
                    ModelMaxConcurrency = fallbackLegacyModel.MaxConcurrency,
                    IsFallback = true,
                    FallbackReason = $"模型池 '{originalPool?.Name}' 中所有模型不可用，回退到直连模型",
                    OriginalPoolId = originalPool?.Id,
                    OriginalPoolName = originalPool?.Name,
                    OriginalModels = originalModels
                };
            }
        }

        var legacyConfigFallback = await TryResolveLegacyConfigFallbackAsync(modelType, expectedModel, ct);
        if (legacyConfigFallback != null)
        {
            return legacyConfigFallback;
        }

        _logger.LogWarning(
            "[ModelResolver] 模型池内所有模型不可用且 legacy 未命中: AppCallerCode={Code}, ModelType={Type}, 原始模型池={PoolName}, 模型状态={ModelStates}",
            appCallerCode, modelType, originalPool?.Name ?? "(无)",
            string.Join(", ", originalModels?.Select(m => $"{m.ModelId}={m.HealthStatus}") ?? Array.Empty<string>()));

        return ModelResolutionResult.NotFound(expectedModel,
            $"模型池内所有模型不可用: AppCallerCode={appCallerCode}, ModelType={modelType}",
            poolFailureCode,
            poolFailureStage,
            appCallerCode,
            modelPoolId: originalPool?.Id);
    }

    /// <inheritdoc />
    public async Task<ModelResolutionResult> ResolveOfferingAsync(
        string appCallerCode,
        string modelType,
        string offeringId,
        CancellationToken ct = default)
    {
        var resolved = await ResolveOfferingCoreAsync(appCallerCode, modelType, offeringId, ct);
        return await ApplyCatalogGateAsync(resolved, appCallerCode, ct);
    }

    private async Task<ModelResolutionResult> ResolveOfferingCoreAsync(
        string appCallerCode,
        string modelType,
        string offeringId,
        CancellationToken ct = default)
    {
        var requiredOfferingId = (offeringId ?? string.Empty).Trim();
        if (_gatewayDb is null || string.IsNullOrWhiteSpace(requiredOfferingId))
        {
            return ModelResolutionResult.NotFound(
                requiredOfferingId,
                "缺少可恢复的 Offering 路由",
                GatewayRouteFailure.OfferingUnresolvable,
                "offering-restore-missing",
                appCallerCode,
                offeringId: requiredOfferingId);
        }

        var offerings = _gatewayDb.Context.Database
            .GetCollection<GatewayModelOffering>("llmgw_model_offerings");
        var offering = await offerings.Find(Builders<GatewayModelOffering>.Filter.And(
                Builders<GatewayModelOffering>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                // Enabled 和健康状态只控制新任务调度。已经被上游受理的任务仍必须
                // 回到持久化的原 Offering 查询状态和下载结果。
                Builders<GatewayModelOffering>.Filter.Eq(x => x.Id, requiredOfferingId)))
            .FirstOrDefaultAsync(ct);
        if (offering is null)
        {
            return ModelResolutionResult.NotFound(
                requiredOfferingId,
                "视频任务原上游当前不可用，请稍后重试或重新生成",
                GatewayRouteFailure.ProviderUnavailable,
                "offering-restore-health",
                appCallerCode,
                offeringId: requiredOfferingId);
        }

        var logicalModels = _gatewayDb.Context.Database
            .GetCollection<GatewayLogicalModel>("llmgw_logical_models");
        var logical = await logicalModels.Find(Builders<GatewayLogicalModel>.Filter.And(
                Builders<GatewayLogicalModel>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                Builders<GatewayLogicalModel>.Filter.Eq(x => x.Id, offering.LogicalModelId),
                Builders<GatewayLogicalModel>.Filter.Eq(x => x.ModelType, modelType)))
            .FirstOrDefaultAsync(ct);
        if (logical is null || !SupportsAppCallerScenario(logical, appCallerCode))
        {
            return ModelResolutionResult.NotFound(
                requiredOfferingId,
                "视频任务原模型路由已失效，请重新生成",
                GatewayRouteFailure.OfferingUnresolvable,
                "offering-restore-logical-model",
                appCallerCode,
                offeringId: requiredOfferingId);
        }

        var resolved = await TryBuildLogicalOfferingResolutionAsync(
            logical,
            offering,
            logical.PublicId,
            ct,
            requireEnabled: false);
        return resolved ?? ModelResolutionResult.NotFound(
            requiredOfferingId,
            "视频任务原上游配置已失效，请重新生成",
            GatewayRouteFailure.OfferingUnresolvable,
            "offering-restore-target",
            appCallerCode,
            offeringId: requiredOfferingId);
    }

    /// <inheritdoc />
    public async Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct = default)
    {
        var result = new List<AvailableModelPool>();
        var gatewayRegistry = await TryGetGatewayRegistryGroupsAsync(appCallerCode, modelType, ct);
        if (gatewayRegistry.TrafficRejected)
            return result;

        if (gatewayRegistry.StrictPoolContract)
        {
            foreach (var group in gatewayRegistry.Groups)
            {
                result.Add(await MapToAvailablePoolAsync(
                    group,
                    "GatewayRegistryPool",
                    true,
                    string.Equals(group.Id, gatewayRegistry.DefaultModelPoolId, StringComparison.Ordinal),
                    ct));
            }
            return result;
        }

        // 有逻辑模型目录时，它就是应用侧模型列表的权威来源。每个逻辑模型只暴露一个稳定 PublicId，
        // Provider/Endpoint/Offering 不泄漏到应用选择器；仅旧 AppCaller 继续使用此兼容目录。
        var logicalModels = await GetAvailableLogicalModelsAsPoolsAsync(appCallerCode, modelType, ct);
        if (logicalModels.Count > 0)
            return logicalModels;

        foreach (var group in gatewayRegistry.Groups)
        {
            result.Add(await MapToAvailablePoolAsync(group, "GatewayRegistryPool", true, false, ct));
        }
        if (result.Count > 0)
            return result;
        if (!string.Equals(CurrentTenantId, _internalTenantId, StringComparison.Ordinal))
            return result;
        if (DisableMapConfigFallbackForRegisteredAppCallers())
            return result;

        // 1. 查找专属模型池
        var appCaller = await _db.LLMAppCallers
            .Find(a => a.AppCode == appCallerCode)
            .FirstOrDefaultAsync(ct);

        if (appCaller != null)
        {
            var requirement = appCaller.ModelRequirements
                .FirstOrDefault(r => r.ModelType == modelType);

            if (requirement?.ModelGroupIds?.Count > 0)
            {
                var dedicatedGroups = await _db.ModelGroups
                    .Find(g => requirement.ModelGroupIds.Contains(g.Id))
                    .SortBy(g => g.Priority)
                    .ToListAsync(ct);

                foreach (var group in dedicatedGroups)
                {
                    result.Add(await MapToAvailablePoolAsync(group, "DedicatedPool", true, false, ct));
                }

                if (result.Count > 0)
                    return result;
            }
        }

        // 2. 查找默认模型池
        var defaultGroups = await _db.ModelGroups
            .Find(g => g.ModelType == modelType && g.IsDefaultForType)
            .SortBy(g => g.Priority)
            .ToListAsync(ct);

        foreach (var group in defaultGroups)
        {
            result.Add(await MapToAvailablePoolAsync(group, "DefaultPool", false, true, ct));
        }

        return result;
    }

    /// <inheritdoc />
    public async Task RecordSuccessAsync(ModelResolutionResult resolution, CancellationToken ct = default)
    {
        if (!string.IsNullOrWhiteSpace(resolution.OfferingId) && _gatewayDb is not null)
        {
            var offerings = _gatewayDb.Context.Database.GetCollection<GatewayModelOffering>("llmgw_model_offerings");
            var filter = Builders<GatewayModelOffering>.Filter.And(
                Builders<GatewayModelOffering>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                Builders<GatewayModelOffering>.Filter.Eq(x => x.Id, resolution.OfferingId));
            var update = Builders<GatewayModelOffering>.Update
                .Inc(x => x.ConsecutiveSuccesses, 1)
                .Set(x => x.ConsecutiveFailures, 0)
                .Set(x => x.HealthStatus, ModelHealthStatus.Healthy)
                .Set(x => x.LastSuccessAt, DateTime.UtcNow)
                .Set(x => x.UpdatedAt, DateTime.UtcNow);
            await offerings.UpdateOneAsync(filter, update, cancellationToken: ct);
            return;
        }

        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId) ||
            string.IsNullOrWhiteSpace(resolution.ActualPlatformId) ||
            string.IsNullOrWhiteSpace(resolution.ActualModel))
            return;

        try
        {
            var filter = Builders<ModelGroup>.Filter.And(
                Builders<ModelGroup>.Filter.Eq(g => g.Id, resolution.ModelGroupId),
                Builders<ModelGroup>.Filter.ElemMatch(g => g.Models,
                    m => m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel));

            var update = Builders<ModelGroup>.Update
                .Inc("Models.$.ConsecutiveSuccesses", 1)
                .Set("Models.$.ConsecutiveFailures", 0)
                .Set("Models.$.HealthStatus", ModelHealthStatus.Healthy)
                .Set("Models.$.LastSuccessAt", DateTime.UtcNow)
                .Unset("Models.$.HalfOpenLeaseUntil")
                .Unset("Models.$.ManualRecoveryAt");

            await GetHealthModelGroups(resolution).UpdateOneAsync(filter, update, cancellationToken: ct);

            _logger.LogDebug(
                "[ModelResolver] 记录成功: Model={Model}, Group={Group}",
                resolution.ActualModel, resolution.ModelGroupName);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ModelResolver] 记录成功状态失败");
        }
    }

    /// <inheritdoc />
    public async Task RecordFailureAsync(ModelResolutionResult resolution, CancellationToken ct = default)
    {
        if (!string.IsNullOrWhiteSpace(resolution.OfferingId) && _gatewayDb is not null)
        {
            var offerings = _gatewayDb.Context.Database.GetCollection<GatewayModelOffering>("llmgw_model_offerings");
            var filter = Builders<GatewayModelOffering>.Filter.And(
                Builders<GatewayModelOffering>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                Builders<GatewayModelOffering>.Filter.Eq(x => x.Id, resolution.OfferingId));
            var current = await offerings.Find(filter).FirstOrDefaultAsync(ct);
            if (current is null) return;
            var failures = current.ConsecutiveFailures + 1;
            var status = failures >= 5 ? ModelHealthStatus.Unavailable
                : failures >= 3 ? ModelHealthStatus.Degraded
                : ModelHealthStatus.Healthy;
            var update = Builders<GatewayModelOffering>.Update
                .Inc(x => x.ConsecutiveFailures, 1)
                .Set(x => x.ConsecutiveSuccesses, 0)
                .Set(x => x.HealthStatus, status)
                .Set(x => x.LastFailedAt, DateTime.UtcNow)
                .Set(x => x.UpdatedAt, DateTime.UtcNow);
            await offerings.UpdateOneAsync(filter, update, cancellationToken: ct);
            return;
        }

        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId) ||
            string.IsNullOrWhiteSpace(resolution.ActualPlatformId) ||
            string.IsNullOrWhiteSpace(resolution.ActualModel))
            return;

        try
        {
            // 先获取当前失败次数
            var modelGroups = GetHealthModelGroups(resolution);
            var group = await modelGroups
                .Find(g => g.Id == resolution.ModelGroupId)
                .FirstOrDefaultAsync(ct);

            var model = group?.Models?.FirstOrDefault(m =>
                m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel);

            if (model == null) return;

            var newFailures = model.ConsecutiveFailures + 1;
            var newStatus = newFailures >= 5 ? ModelHealthStatus.Unavailable :
                            newFailures >= 3 ? ModelHealthStatus.Degraded :
                            ModelHealthStatus.Healthy;

            var filter = Builders<ModelGroup>.Filter.And(
                Builders<ModelGroup>.Filter.Eq(g => g.Id, resolution.ModelGroupId),
                Builders<ModelGroup>.Filter.ElemMatch(g => g.Models,
                    m => m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel));

            var update = Builders<ModelGroup>.Update
                .Inc("Models.$.ConsecutiveFailures", 1)
                .Set("Models.$.ConsecutiveSuccesses", 0)
                .Set("Models.$.HealthStatus", newStatus)
                .Set("Models.$.LastFailedAt", DateTime.UtcNow)
                .Unset("Models.$.HalfOpenLeaseUntil")
                .Unset("Models.$.ManualRecoveryAt");

            await modelGroups.UpdateOneAsync(filter, update, cancellationToken: ct);

            _logger.LogWarning(
                "[ModelResolver] 记录失败: Model={Model}, Failures={Count}, Status={Status}",
                resolution.ActualModel, newFailures, newStatus);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ModelResolver] 记录失败状态失败");
        }
    }

    /// <inheritdoc />
    public async Task RecordUnavailableAsync(ModelResolutionResult resolution, CancellationToken ct = default)
    {
        if (!string.IsNullOrWhiteSpace(resolution.OfferingId) && _gatewayDb is not null)
        {
            var offerings = _gatewayDb.Context.Database.GetCollection<GatewayModelOffering>("llmgw_model_offerings");
            var offeringFilter = Builders<GatewayModelOffering>.Filter.And(
                Builders<GatewayModelOffering>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                Builders<GatewayModelOffering>.Filter.Eq(x => x.Id, resolution.OfferingId));
            var offeringUpdate = Builders<GatewayModelOffering>.Update
                .Inc(x => x.ConsecutiveFailures, 1)
                .Set(x => x.ConsecutiveSuccesses, 0)
                .Set(x => x.HealthStatus, ModelHealthStatus.Unavailable)
                .Set(x => x.LastFailedAt, DateTime.UtcNow)
                .Set(x => x.UpdatedAt, DateTime.UtcNow);
            await offerings.UpdateOneAsync(offeringFilter, offeringUpdate, cancellationToken: ct);
            return;
        }

        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId) ||
            string.IsNullOrWhiteSpace(resolution.ActualPlatformId) ||
            string.IsNullOrWhiteSpace(resolution.ActualModel))
            return;

        var groupFilter = Builders<ModelGroup>.Filter.And(
            Builders<ModelGroup>.Filter.Eq(g => g.Id, resolution.ModelGroupId),
            Builders<ModelGroup>.Filter.ElemMatch(g => g.Models,
                m => m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel));
        var groupUpdate = Builders<ModelGroup>.Update
            .Inc("Models.$.ConsecutiveFailures", 1)
            .Set("Models.$.ConsecutiveSuccesses", 0)
            .Set("Models.$.HealthStatus", ModelHealthStatus.Unavailable)
            .Set("Models.$.LastFailedAt", DateTime.UtcNow);
        await GetHealthModelGroups(resolution).UpdateOneAsync(groupFilter, groupUpdate, cancellationToken: ct);
    }

    #region Private Methods

    private async Task<List<AvailableModelPool>> GetAvailableLogicalModelsAsPoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct)
    {
        if (_gatewayDb is null)
            return [];
        var logicalCollection = _gatewayDb.Context.Database.GetCollection<GatewayLogicalModel>("llmgw_logical_models");
        var offeringCollection = _gatewayDb.Context.Database.GetCollection<GatewayModelOffering>("llmgw_model_offerings");
        var logicalModels = await logicalCollection.Find(Builders<GatewayLogicalModel>.Filter.And(
                Builders<GatewayLogicalModel>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                Builders<GatewayLogicalModel>.Filter.Eq(x => x.Enabled, true),
                Builders<GatewayLogicalModel>.Filter.Eq(x => x.ModelType, modelType)))
            .SortBy(x => x.DisplayOrder)
            .ThenBy(x => x.Name)
            .ToListAsync(ct);
        if (logicalModels.Count == 0)
            return [];
        var ids = logicalModels.Select(x => x.Id).ToList();
        var offerings = await offeringCollection.Find(Builders<GatewayModelOffering>.Filter.And(
                Builders<GatewayModelOffering>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                Builders<GatewayModelOffering>.Filter.In(x => x.LogicalModelId, ids),
                Builders<GatewayModelOffering>.Filter.Eq(x => x.Enabled, true),
                Builders<GatewayModelOffering>.Filter.Ne(x => x.HealthStatus, ModelHealthStatus.Unavailable)))
            .ToListAsync(ct);
        var offeringsByLogicalModel = offerings
            .GroupBy(x => x.LogicalModelId, StringComparer.Ordinal)
            .ToDictionary(x => x.Key, x => x.ToList(), StringComparer.Ordinal);
        var result = new List<AvailableModelPool>();
        foreach (var logical in logicalModels)
        {
            if (!SupportsAppCallerScenario(logical, appCallerCode))
                continue;

            if (!offeringsByLogicalModel.TryGetValue(logical.Id, out var logicalOfferings))
                continue;

            // “启用且健康”只是控制面状态，不代表 Offering 指向的 Exchange、模型和平台仍然存在。
            // 选择器只能展示在当前租户与 appCaller 下至少能完整解析一个上游的逻辑模型，避免用户
            // 选中后才得到“模型不可用”。这里复用实际解析构建器，保证目录与执行链路采用同一规则。
            var hasResolvableOffering = false;
            foreach (var offering in OrderLogicalOfferings(logical, logicalOfferings))
            {
                if (await TryBuildLogicalOfferingResolutionAsync(logical, offering, logical.PublicId, ct) is not null)
                {
                    hasResolvableOffering = true;
                    break;
                }
            }
            if (!hasResolvableOffering)
                continue;

            result.Add(new AvailableModelPool
            {
                Id = logical.Id,
                Name = logical.Name,
                Code = logical.PublicId,
                Priority = logical.DisplayOrder,
                ResolutionType = "LogicalModel",
                IsDedicated = logical.AllowedAppCallerCodes.Count > 0,
                IsDefault = false,
                Capabilities = logical.Capabilities?.ToList() ?? [],
                Models =
                [
                    new PoolModelInfo
                    {
                        ModelId = logical.PublicId,
                        PlatformId = "logical-model",
                        PlatformName = "LLM Gateway",
                        Priority = 1,
                        HealthStatus = "Healthy",
                        HealthScore = 100,
                    }
                ],
            });
        }

        return result;
    }

    private async Task<ModelResolutionResult?> TryResolveLogicalModelAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel,
        CancellationToken ct)
    {
        if (_gatewayDb is null || string.IsNullOrWhiteSpace(expectedModel))
            return null;

        var key = expectedModel.Trim();
        var normalized = key.ToLowerInvariant();
        var logicalModels = _gatewayDb.Context.Database.GetCollection<GatewayLogicalModel>("llmgw_logical_models");
        var logical = await logicalModels.Find(Builders<GatewayLogicalModel>.Filter.And(
                Builders<GatewayLogicalModel>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                Builders<GatewayLogicalModel>.Filter.Eq(x => x.Enabled, true),
                Builders<GatewayLogicalModel>.Filter.Eq(x => x.ModelType, modelType),
                Builders<GatewayLogicalModel>.Filter.Or(
                    Builders<GatewayLogicalModel>.Filter.Eq(x => x.PublicIdNormalized, normalized),
                    Builders<GatewayLogicalModel>.Filter.Eq(x => x.PublicId, key))))
            .FirstOrDefaultAsync(ct);
        if (logical is null)
            return null;

        if (!SupportsAppCallerScenario(logical, appCallerCode))
        {
            return ModelResolutionResult.NotFound(expectedModel,
                $"逻辑模型不支持当前 appCaller 场景: model={logical.PublicId}, appCaller={appCallerCode}, "
                + $"capabilities=[{string.Join(",", logical.Capabilities)}], "
                + $"required={GatewayCapabilityContract.RequiredScenarioCapability(appCallerCode) ?? "(无)"}",
                GatewayRouteFailure.LogicalModelCapabilityMismatch,
                "logical-model-capability",
                appCallerCode,
                logicalModelPublicId: logical.PublicId);
        }

        var offerings = _gatewayDb.Context.Database.GetCollection<GatewayModelOffering>("llmgw_model_offerings");
        var available = await offerings.Find(Builders<GatewayModelOffering>.Filter.And(
                Builders<GatewayModelOffering>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                Builders<GatewayModelOffering>.Filter.Eq(x => x.LogicalModelId, logical.Id),
                Builders<GatewayModelOffering>.Filter.Eq(x => x.Enabled, true),
                Builders<GatewayModelOffering>.Filter.Ne(x => x.HealthStatus, ModelHealthStatus.Unavailable)))
            .ToListAsync(ct);

        var ordered = OrderLogicalOfferings(logical, available);
        var resolved = new List<ModelResolutionResult>();
        foreach (var offering in ordered)
        {
            var candidate = await TryBuildLogicalOfferingResolutionAsync(logical, offering, expectedModel, ct);
            if (candidate is not null)
                resolved.Add(candidate);
        }

        if (resolved.Count == 0)
        {
            return ModelResolutionResult.NotFound(expectedModel,
                $"逻辑模型没有可用上游 Offering: {logical.PublicId}",
                GatewayRouteFailure.OfferingUnresolvable,
                "logical-model-offering",
                appCallerCode,
                logicalModelPublicId: logical.PublicId);
        }

        var selected = resolved[0];
        if (resolved.Count > 1)
            selected.RetryCandidates = resolved.Skip(1).ToList();
        return selected;
    }

    /// <summary>
    /// 逻辑模型能否服务该 appCaller 的场景。
    ///
    /// 判据本体在 <see cref="GatewayCapabilityContract.SupportsAppCallerScenario"/>，这里只做转发。
    /// 曾经这段逻辑在 Resolver 里自带一份能力字面量清单（含事故止血时追加的 "image-gen" 特判），
    /// 而写入侧、readiness、控制台各有另一份——同一个问题四个答案，
    /// 结果正式数据用历史值时运行时判 false、readiness 判 true，全站生图静默不可用而所有灯是绿的。
    /// 现在别名归一与场景判定只此一处；任何调用方都不许再写第二份。
    /// </summary>
    internal static bool SupportsAppCallerScenario(GatewayLogicalModel logical, string appCallerCode)
        => GatewayCapabilityContract.SupportsAppCallerScenario(
            logical.Capabilities,
            logical.AllowedAppCallerCodes,
            appCallerCode);

    private List<GatewayModelOffering> OrderLogicalOfferings(
        GatewayLogicalModel logical,
        List<GatewayModelOffering> offerings)
    {
        var ordered = offerings
            .OrderBy(x => x.HealthStatus == ModelHealthStatus.Healthy ? 0 : 1)
            .ThenBy(x => x.Priority)
            .ThenBy(x => x.Id, StringComparer.Ordinal)
            .ToList();
        if (!string.Equals(logical.RoutingStrategy, "weighted", StringComparison.OrdinalIgnoreCase)
            || ordered.Count < 2)
            return ordered;

        var seedText = $"{_requestContext?.Current?.RequestId ?? Guid.NewGuid().ToString("N")}::{logical.Id}";
        var seed = BitConverter.ToUInt32(SHA256.HashData(Encoding.UTF8.GetBytes(seedText)), 0);
        var totalWeight = ordered.Sum(x => Math.Max(1, x.Weight));
        var cursor = (int)(seed % (uint)totalWeight);
        var firstIndex = 0;
        for (var i = 0; i < ordered.Count; i++)
        {
            cursor -= Math.Max(1, ordered[i].Weight);
            if (cursor < 0)
            {
                firstIndex = i;
                break;
            }
        }
        return ordered.Skip(firstIndex).Concat(ordered.Take(firstIndex)).ToList();
    }

    private async Task<ModelResolutionResult?> TryBuildLogicalOfferingResolutionAsync(
        GatewayLogicalModel logical,
        GatewayModelOffering offering,
        string expectedModel,
        CancellationToken ct,
        bool requireEnabled = true)
    {
        var capabilities = logical.Capabilities.Select(type => new LLMModelCapability
        {
            Type = type,
            Source = "logical-model",
            Value = true,
            UpdatedAt = logical.UpdatedAt
        }).ToList();
        var item = new ModelGroupItem
        {
            ModelId = offering.UpstreamModelId ?? string.Empty,
            Priority = offering.Priority,
            Protocol = offering.Protocol,
            HealthStatus = offering.HealthStatus,
            ConsecutiveFailures = offering.ConsecutiveFailures,
            ConsecutiveSuccesses = offering.ConsecutiveSuccesses,
            Capabilities = capabilities
        };
        var logicalGroup = new ModelGroup
        {
            Id = logical.Id,
            Name = logical.Name,
            Code = logical.PublicId,
            ModelType = logical.ModelType,
            Priority = logical.DisplayOrder
        };

        if (string.Equals(offering.TargetKind, "exchange", StringComparison.OrdinalIgnoreCase))
        {
            var exchangeFilter = Builders<ModelExchange>.Filter.Eq(x => x.Id, offering.TargetId);
            if (requireEnabled)
                exchangeFilter &= Builders<ModelExchange>.Filter.Eq(x => x.Enabled, true);
            var exchange = await FindGatewayOwnedExchangeAsync(
                exchangeFilter,
                ct);
            if (exchange is null) return null;
            item.PlatformId = exchange.Id;
            if (string.IsNullOrWhiteSpace(item.ModelId))
                item.ModelId = exchange.ModelAlias;
            var apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(exchange.TargetApiKeyEncrypted, _config);
            return ModelResolutionResult.FromExchangePool(
                "LogicalModel", expectedModel, item, logicalGroup, exchange, apiKey,
                logical.Id, logical.PublicId, offering.Id, "exchange",
                offering.MaxConcurrency, offering.RateLimitPerMinute, offering.EndpointPath);
        }

        var modelCollection = _gatewayDb!.Context.Database.GetCollection<LLMModel>("llmgw_models");
        var modelFilter = Builders<LLMModel>.Filter.And(
            Builders<LLMModel>.Filter.Eq("TenantId", CurrentTenantId),
            Builders<LLMModel>.Filter.Eq(x => x.Id, offering.TargetId));
        if (requireEnabled)
            modelFilter &= Builders<LLMModel>.Filter.Eq(x => x.Enabled, true);
        var model = await modelCollection.Find(modelFilter)
            .FirstOrDefaultAsync(ct);
        if (model is null || string.IsNullOrWhiteSpace(model.PlatformId)) return null;
        var platform = await FindGatewayOwnedOrMapPlatformAsync(
            model.PlatformId,
            requireEnabled,
            ct,
            allowMapFallback: false);
        if (platform is null) return null;

        item.PlatformId = platform.Id;
        if (string.IsNullOrWhiteSpace(item.ModelId))
            item.ModelId = model.ModelName;
        if (string.IsNullOrWhiteSpace(item.Protocol))
            item.Protocol = model.Protocol;
        var endpointPlatform = new LLMPlatform
        {
            Id = platform.Id,
            Name = platform.Name,
            PlatformType = platform.PlatformType,
            ProviderId = platform.ProviderId,
            ApiUrl = model.ApiUrl ?? platform.ApiUrl,
            ApiKeyEncrypted = platform.ApiKeyEncrypted,
            Enabled = platform.Enabled,
            MaxConcurrency = platform.MaxConcurrency,
            Remark = platform.Remark,
            CreatedAt = platform.CreatedAt,
            UpdatedAt = platform.UpdatedAt
        };
        var encryptedKey = string.IsNullOrWhiteSpace(model.ApiKeyEncrypted)
            ? platform.ApiKeyEncrypted
            : model.ApiKeyEncrypted;
        var apiKeyValue = ApiKeyCryptoKeyRing.DecryptPlainOrNull(encryptedKey, _config);
        return ModelResolutionResult.FromPool(
            "LogicalModel", expectedModel, item, logicalGroup, endpointPlatform, apiKeyValue, model,
            logical.Id, logical.PublicId, offering.Id, "model", offering.MaxConcurrency,
            offering.RateLimitPerMinute, offering.EndpointPath);
    }

    /// <summary>
    /// 按模型池条目查找对应的 Exchange。支持两种 PlatformId:
    ///   A) "__exchange__"（旧虚拟平台 id）— 用 ModelId 反查 Exchange.ModelAlias / ModelAliases / Models
    ///   B) Exchange.Id（新虚拟平台 id）— 直接按 Id 查
    /// 未匹配时返回 null，由调用方决定降级到普通平台还是跳过。
    /// </summary>
    private async Task<ModelExchange?> FindExchangeForPoolItemAsync(
        ModelGroupItem selectedModel,
        bool allowMapFallback,
        CancellationToken ct)
    {
        if (selectedModel.PlatformId == ModelResolverConstants.ExchangePlatformId)
        {
            // A) 旧数据：按 ModelId 反查
            var legacyFilter = Builders<ModelExchange>.Filter.And(
                Builders<ModelExchange>.Filter.Eq(e => e.Enabled, true),
                Builders<ModelExchange>.Filter.Or(
                    Builders<ModelExchange>.Filter.Eq(e => e.ModelAlias, selectedModel.ModelId),
                    Builders<ModelExchange>.Filter.AnyEq(e => e.ModelAliases, selectedModel.ModelId),
                    Builders<ModelExchange>.Filter.ElemMatch(
                        e => e.Models,
                        Builders<ExchangeModel>.Filter.Eq(m => m.ModelId, selectedModel.ModelId))
                )
            );
            var gatewayExchange = await FindGatewayOwnedExchangeAsync(legacyFilter, ct);
            if (gatewayExchange is not null)
                return gatewayExchange;
            if (!allowMapFallback)
                return null;
            return await _db.ModelExchanges.Find(legacyFilter).FirstOrDefaultAsync(ct);
        }

        // B) 新数据：PlatformId 就是 Exchange.Id，直接按 Id 查
        var byIdFilter = Builders<ModelExchange>.Filter.And(
            Builders<ModelExchange>.Filter.Eq(e => e.Id, selectedModel.PlatformId),
            Builders<ModelExchange>.Filter.Eq(e => e.Enabled, true)
        );
        var exchange = await FindGatewayOwnedExchangeAsync(byIdFilter, ct)
                       ?? (allowMapFallback ? await _db.ModelExchanges.Find(byIdFilter).FirstOrDefaultAsync(ct) : null);
        if (exchange == null) return null;

        // 校验 ModelId 在 Exchange 的有效模型列表里
        var effectiveModels = exchange.GetEffectiveModels();
        var hit = effectiveModels.Any(m =>
            m.Enabled && string.Equals(m.ModelId, selectedModel.ModelId, StringComparison.Ordinal));
        if (!hit)
        {
            _logger.LogWarning(
                "[ModelResolver] Exchange {ExchangeId} ({ExchangeName}) 下未找到启用的模型 {ModelId}",
                exchange.Id, exchange.Name, selectedModel.ModelId);
            return null;
        }
        return exchange;
    }

    /// <summary>
    /// 在候选池列表中寻找用户期望的模型。
    /// 匹配规则（按优先级）：
    ///   1. 池中某个 ModelId 完全匹配 expectedModel（健康模型优先）
    ///   2. 池中某个 ModelId 是 expectedModel 的前缀（容差：带版本号）
    ///   3. 池 Id / 池名 / 池 Code 匹配 expectedModel（pool 策略可直接发 GW ModelPoolId）
    ///
    /// 健康约束：只返回非 Unavailable 的模型。用户选的池若全部不可用，
    /// 返回 (null, null) 让上层走"询问用户是否切换"路径（前端发起请求前已做预检）。
    /// 这里不做命名归一化（如 "1.5" ↔ "1-5"）——池 Code 是系统自动填充的，
    /// 不会出现用户手填造成的命名漂移。
    /// </summary>
    private (ModelGroup? group, ModelGroupItem? item) FindPreferredModel(
        List<ModelGroup> groups, string expectedModel)
    {
        if (groups.Count == 0 || string.IsNullOrWhiteSpace(expectedModel))
            return (null, null);

        var key = expectedModel.Trim();

        _logger.LogInformation(
            "[ModelResolver] FindPreferredModel 开始: key='{Key}', 候选池={Count} [{Pools}]",
            key, groups.Count,
            string.Join(", ", groups.Select(g => $"{g.Name}(code={g.Code})")));

        // 优先级 1：ModelId 精确匹配
        foreach (var g in groups)
        {
            if (g.Models == null) continue;
            var exact = g.Models.FirstOrDefault(m =>
                m.HealthStatus != ModelHealthStatus.Unavailable &&
                string.Equals(m.ModelId, key, StringComparison.OrdinalIgnoreCase));
            if (exact != null)
            {
                _logger.LogInformation("[ModelResolver] Tier1 命中: pool={Pool}, modelId={ModelId}", g.Name, exact.ModelId);
                return (g, exact);
            }
        }

        // 优先级 2：ModelId 前缀匹配
        foreach (var g in groups)
        {
            if (g.Models == null) continue;
            var prefix = g.Models.FirstOrDefault(m =>
                m.HealthStatus != ModelHealthStatus.Unavailable &&
                !string.IsNullOrEmpty(m.ModelId) &&
                m.ModelId.StartsWith(key, StringComparison.OrdinalIgnoreCase));
            if (prefix != null)
            {
                _logger.LogInformation("[ModelResolver] Tier2 命中: pool={Pool}, modelId={ModelId}", g.Name, prefix.ModelId);
                return (g, prefix);
            }
        }

        // 优先级 3：池 Id / 池名 / 池 Code 精确匹配（picker 发的 modelId 实际是池 Code）
        foreach (var g in groups)
        {
            if (g.Models == null || g.Models.Count == 0) continue;
            var matchByPool =
                string.Equals(g.Id, key, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(g.Name, key, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(g.Code, key, StringComparison.OrdinalIgnoreCase);
            if (!matchByPool) continue;

            // Healthy > Degraded；Unavailable 不选（交给前端走"询问切换"）
            var picked =
                g.Models.FirstOrDefault(m => m.HealthStatus == ModelHealthStatus.Healthy)
                ?? g.Models.FirstOrDefault(m => m.HealthStatus == ModelHealthStatus.Degraded);
            if (picked != null)
            {
                _logger.LogInformation(
                    "[ModelResolver] Tier3 命中: pool={Pool}, modelId={ModelId}, health={Health}",
                    g.Name, picked.ModelId, picked.HealthStatus);
                return (g, picked);
            }

            _logger.LogInformation(
                "[ModelResolver] Tier3 池名/Code 匹配但池内无可用模型: pool={Pool} (共{Count}个)",
                g.Name, g.Models.Count);
        }

        _logger.LogInformation(
            "[ModelResolver] FindPreferredModel 所有档位未命中: key='{Key}'",
            key);
        return (null, null);
    }

    // legacy 直连兜底：未迁移到 ModelGroups 的部署仍按 IsMain/IsIntent/IsVision/IsImageGen 标记选模型。
    // 迁移自动化前保留；已建默认池的部署解析在前面就命中，不会走到这里。
    private async Task<LLMModel?> FindLegacyModelAsync(string modelType, CancellationToken ct)
    {
        LLMModel? result = modelType.ToLowerInvariant() switch
        {
            "chat" => await _db.LLMModels.Find(m => m.IsMain && m.Enabled).FirstOrDefaultAsync(ct),
            "intent" => await _db.LLMModels.Find(m => m.IsIntent && m.Enabled).FirstOrDefaultAsync(ct),
            "vision" => await _db.LLMModels.Find(m => m.IsVision && m.Enabled).FirstOrDefaultAsync(ct),
            "generation" => await _db.LLMModels.Find(m => m.IsImageGen && m.Enabled).FirstOrDefaultAsync(ct),
            _ => null
        };
        return result;
    }

    private async Task<ModelResolutionResult?> TryResolvePinnedModelAsync(
        string appCallerCode,
        string? expectedModel,
        string? pinnedPlatformId,
        string? pinnedModelId,
        CancellationToken ct,
        bool allowMapFallback = true)
    {
        var platformId = pinnedPlatformId?.Trim();
        var modelId = pinnedModelId?.Trim();
        var hasAnyPin = !string.IsNullOrWhiteSpace(platformId) || !string.IsNullOrWhiteSpace(modelId);
        if (!hasAnyPin)
            return null;

        if (string.IsNullOrWhiteSpace(platformId) || string.IsNullOrWhiteSpace(modelId))
        {
            return ModelResolutionResult.NotFound(
                expectedModel ?? modelId,
                "PinnedModel 调用必须同时提供 pinnedPlatformId 与 pinnedModelId",
                GatewayRouteFailure.RouteConfigIncompatible,
                "pinned-arguments",
                appCallerCode);
        }

        var platform = await FindGatewayOwnedOrMapPlatformAsync(platformId, enabledOnly: true, ct, allowMapFallback);
        if (platform == null)
        {
            return ModelResolutionResult.NotFound(
                expectedModel ?? modelId,
                $"PinnedModel 平台不存在或未启用: {platformId}",
                GatewayRouteFailure.PlatformDisabled,
                "pinned-platform",
                appCallerCode);
        }

        var model = await FindGatewayOwnedOrMapModelAsync(platformId, modelId, ct, allowMapFallback);
        if (model == null)
        {
            return ModelResolutionResult.NotFound(
                expectedModel ?? modelId,
                $"PinnedModel 模型不存在或未启用: platform={platformId}, model={modelId}",
                GatewayRouteFailure.RouteConfigIncompatible,
                "pinned-model",
                appCallerCode);
        }

        var apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(model.ApiKeyEncrypted, _config);
        if (string.IsNullOrWhiteSpace(apiKey))
            apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(platform.ApiKeyEncrypted, _config);

        if (string.IsNullOrWhiteSpace(model.ApiUrl) && string.IsNullOrWhiteSpace(platform.ApiUrl))
        {
            return ModelResolutionResult.NotFound(
                expectedModel ?? modelId,
                $"PinnedModel API URL 配置不完整: platform={platformId}, model={modelId}",
                GatewayRouteFailure.RouteConfigIncompatible,
                "pinned-endpoint",
                appCallerCode);
        }

        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return ModelResolutionResult.NotFound(
                expectedModel ?? modelId,
                $"PinnedModel API Key 配置不完整: platform={platformId}, model={modelId}",
                GatewayRouteFailure.RouteConfigIncompatible,
                "pinned-credential",
                appCallerCode);
        }

        _logger.LogInformation(
            "[ModelResolver] PinnedModel 调度完成: Expected={Expected}, Platform={Platform}, Model={Model}",
            expectedModel ?? modelId,
            platform.Name,
            model.ModelName);

        return ModelResolutionResult.FromPinned(expectedModel ?? model.ModelName, model, platform, apiKey);
    }

    private async Task<ModelResolutionResult> ResolvePinnedGatewayPoolMemberAsync(
        string appCallerCode,
        ModelGroup group,
        ModelGroupItem member,
        string? expectedModel,
        CancellationToken ct)
    {
        var exchange = await FindExchangeForPoolItemAsync(
            member,
            allowMapFallback: false,
            ct);
        if (exchange is not null)
        {
            var exchangeApiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(
                exchange.TargetApiKeyEncrypted,
                _config);
            if (string.IsNullOrWhiteSpace(exchange.TargetUrl))
            {
                return ModelResolutionResult.NotFound(
                    expectedModel,
                    $"PinnedModel Exchange API URL 配置不完整: exchange={exchange.Id}, model={member.ModelId}",
                    GatewayRouteFailure.OfferingUnresolvable,
                    "pinned-exchange-endpoint",
                    appCallerCode,
                    modelPoolId: group.Id);
            }

            if (string.IsNullOrWhiteSpace(exchangeApiKey))
            {
                return ModelResolutionResult.NotFound(
                    expectedModel,
                    $"PinnedModel Exchange API Key 配置不完整: exchange={exchange.Id}, model={member.ModelId}",
                    GatewayRouteFailure.OfferingUnresolvable,
                    "pinned-exchange-credential",
                    appCallerCode,
                    modelPoolId: group.Id);
            }

            return ModelResolutionResult.FromExchangePool(
                "GatewayRegistryPool",
                expectedModel,
                member,
                group,
                exchange,
                exchangeApiKey);
        }

        if (string.Equals(
                member.PlatformId,
                ModelResolverConstants.ExchangePlatformId,
                StringComparison.Ordinal))
        {
            return ModelResolutionResult.NotFound(
                expectedModel,
                $"PinnedModel Exchange 配置不存在或未启用: model={member.ModelId}",
                GatewayRouteFailure.OfferingUnresolvable,
                "pinned-exchange-missing",
                appCallerCode,
                modelPoolId: group.Id);
        }

        var platform = await FindGatewayOwnedOrMapPlatformAsync(
            member.PlatformId,
            enabledOnly: true,
            ct,
            allowMapFallback: false);
        if (platform is null)
        {
            return ModelResolutionResult.NotFound(
                expectedModel,
                $"PinnedModel 平台不存在或未启用: {member.PlatformId}",
                GatewayRouteFailure.PlatformDisabled,
                "pinned-pool-platform",
                appCallerCode,
                modelPoolId: group.Id);
        }

        var model = await FindGatewayOwnedOrMapModelAsync(
            member.PlatformId,
            member.ModelId,
            ct,
            allowMapFallback: false);
        if (model is null)
        {
            return ModelResolutionResult.NotFound(
                expectedModel,
                $"PinnedModel 模型不存在或未启用: platform={member.PlatformId}, model={member.ModelId}",
                GatewayRouteFailure.RouteConfigIncompatible,
                "pinned-pool-model",
                appCallerCode,
                modelPoolId: group.Id);
        }

        var encryptedKey = string.IsNullOrWhiteSpace(model.ApiKeyEncrypted)
            ? platform.ApiKeyEncrypted
            : model.ApiKeyEncrypted;
        var apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(encryptedKey, _config);
        var effectiveApiUrl = string.IsNullOrWhiteSpace(model.ApiUrl)
            ? platform.ApiUrl
            : model.ApiUrl;
        if (string.IsNullOrWhiteSpace(effectiveApiUrl))
        {
            return ModelResolutionResult.NotFound(
                expectedModel,
                $"PinnedModel API URL 配置不完整: platform={member.PlatformId}, model={member.ModelId}",
                GatewayRouteFailure.RouteConfigIncompatible,
                "pinned-pool-endpoint",
                appCallerCode,
                modelPoolId: group.Id);
        }

        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return ModelResolutionResult.NotFound(
                expectedModel,
                $"PinnedModel API Key 配置不完整: platform={member.PlatformId}, model={member.ModelId}",
                GatewayRouteFailure.RouteConfigIncompatible,
                "pinned-pool-credential",
                appCallerCode,
                modelPoolId: group.Id);
        }

        var endpointPlatform = new LLMPlatform
        {
            Id = platform.Id,
            Name = platform.Name,
            PlatformType = platform.PlatformType,
            ProviderId = platform.ProviderId,
            ApiUrl = effectiveApiUrl,
            ApiKeyEncrypted = platform.ApiKeyEncrypted,
            Enabled = platform.Enabled,
            MaxConcurrency = platform.MaxConcurrency,
            Remark = platform.Remark,
            CreatedAt = platform.CreatedAt,
            UpdatedAt = platform.UpdatedAt
        };
        _logger.LogInformation(
            "[ModelResolver] GW 模型池物理锁定完成: Pool={Pool}, Platform={Platform}, Model={Model}, Health={Health}",
            group.Id,
            member.PlatformId,
            member.ModelId,
            member.HealthStatus);
        return ModelResolutionResult.FromPool(
            "GatewayRegistryPool",
            expectedModel,
            member,
            group,
            endpointPlatform,
            apiKey,
            model);
    }

    private async Task<ModelResolutionResult?> TryResolveLegacyConfigFallbackAsync(string modelType, string? expectedModel, CancellationToken ct)
    {
        if (!string.Equals(modelType, ModelTypes.Chat, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(modelType, ModelTypes.Intent, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var activeConfig = await _db.LLMConfigs.Find(c => c.IsActive).FirstOrDefaultAsync(ct);
        if (activeConfig != null)
        {
            var apiKey = ApiKeyCryptoKeyRing.DecryptPlainOrNull(activeConfig.ApiKeyEncrypted, _config);
            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                var endpoint = activeConfig.ApiEndpoint
                    ?? (string.Equals(activeConfig.Provider, "Claude", StringComparison.OrdinalIgnoreCase)
                        ? "https://api.anthropic.com/"
                        : "https://api.openai.com/");
                _logger.LogWarning(
                    "[ModelResolver] 使用 legacy LLMConfig 兜底: Provider={Provider}, Model={Model}",
                    activeConfig.Provider,
                    activeConfig.Model);
                return ModelResolutionResult.FromLegacyConfig(
                    expectedModel,
                    "LegacyConfig",
                    activeConfig.Provider,
                    activeConfig.Model,
                    endpoint,
                    apiKey);
            }
        }

        var envApiKey = Environment.GetEnvironmentVariable("LLM__ClaudeApiKey") ?? _config["LLM:ClaudeApiKey"];
        if (string.IsNullOrWhiteSpace(envApiKey))
            return null;

        var envModel = Environment.GetEnvironmentVariable("LLM__Model")
            ?? _config["LLM:Model"]
            ?? "claude-3-5-sonnet-20241022";
        _logger.LogWarning(
            "[ModelResolver] 使用环境变量 LLM 配置兜底: Model={Model}",
            envModel);
        return ModelResolutionResult.FromLegacyConfig(
            expectedModel,
            "LegacyEnvironment",
            "Claude",
            envModel,
            "https://api.anthropic.com/",
            envApiKey);
    }

    private ModelGroupItem? SelectBestModel(ModelGroup group)
    {
        if (group.Models == null || group.Models.Count == 0)
            return null;

        // 优先选择健康的模型，按优先级排序
        var healthy = group.Models
            .Where(m => m.HealthStatus == ModelHealthStatus.Healthy)
            .OrderBy(m => m.Priority)
            .FirstOrDefault();

        if (healthy != null)
            return healthy;

        // 其次选择降权的模型
        var degraded = group.Models
            .Where(m => m.HealthStatus == ModelHealthStatus.Degraded)
            .OrderBy(m => m.Priority)
            .FirstOrDefault();

        if (degraded != null)
            return degraded;

        // 最后选择任意可用模型（排除 Unavailable）
        return group.Models
            .Where(m => m.HealthStatus != ModelHealthStatus.Unavailable)
            .OrderBy(m => m.Priority)
            .FirstOrDefault();
    }

    private async Task<List<ModelGroupItem>> SelectProviderRetryCandidatesAsync(
        ModelGroup group,
        bool includeAllAvailable,
        bool gatewayOwned,
        CancellationToken ct)
    {
        if (group.Models == null || group.Models.Count == 0)
            return [];

        var candidates = group.Models
            .Where(m => m.HealthStatus != ModelHealthStatus.Unavailable)
            .OrderBy(m => m.HealthStatus == ModelHealthStatus.Healthy ? 0 : 1)
            .ThenBy(m => m.Priority)
            .ToList();

        if (includeAllAvailable)
        {
            var halfOpen = await TryClaimHalfOpenCandidateAsync(group, gatewayOwned, ct);
            if (halfOpen is not null)
                // 半开成员是本轮恢复探测的优先候选，必须真正占据发送队列首位，
                // 否则先发送健康成员会让半开租约白占位而无法完成验证。
                candidates.Insert(0, halfOpen);
            return candidates;
        }

        return candidates.Count == 0 ? [] : [candidates[0]];
    }

    private async Task<ModelGroupItem?> TryClaimHalfOpenCandidateAsync(
        ModelGroup group,
        bool gatewayOwned,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var cooldownSeconds = Math.Clamp(
            _config.GetValue<int?>("LlmGateway:CircuitBreaker:HalfOpenAfterSeconds") ?? 120,
            10,
            3600);
        var leaseSeconds = Math.Clamp(
            _config.GetValue<int?>("LlmGateway:CircuitBreaker:HalfOpenLeaseSeconds") ?? 30,
            5,
            300);
        var cutoff = now.AddSeconds(-cooldownSeconds);
        var candidate = group.Models
            .Where(member => IsHalfOpenEligible(member, now, cutoff))
            .OrderBy(member => member.Priority)
            .FirstOrDefault();
        if (candidate is null)
            return null;

        var filters = new List<FilterDefinition<ModelGroup>>
        {
            Builders<ModelGroup>.Filter.Eq(item => item.Id, group.Id),
            new BsonDocumentFilterDefinition<ModelGroup>(new BsonDocument("Models", new BsonDocument("$elemMatch", new BsonDocument
            {
                { "ModelId", candidate.ModelId },
                { "PlatformId", candidate.PlatformId },
                { "HealthStatus", (int)ModelHealthStatus.Unavailable },
                { "$or", new BsonArray
                    {
                        new BsonDocument("HalfOpenLeaseUntil", new BsonDocument("$exists", false)),
                        new BsonDocument("HalfOpenLeaseUntil", BsonNull.Value),
                        new BsonDocument("HalfOpenLeaseUntil", new BsonDocument("$lte", now)),
                    }
                },
                { "$and", new BsonArray
                    {
                        new BsonDocument("$or", new BsonArray
                        {
                            new BsonDocument("ManualRecoveryAt", new BsonDocument("$lte", now)),
                            new BsonDocument("LastFailedAt", new BsonDocument("$exists", false)),
                            new BsonDocument("LastFailedAt", BsonNull.Value),
                            new BsonDocument("LastFailedAt", new BsonDocument("$lte", cutoff)),
                        }),
                    }
                },
            })))
        };
        IMongoCollection<ModelGroup> collection;
        if (gatewayOwned && _gatewayDb is not null)
        {
            filters.Add(new BsonDocumentFilterDefinition<ModelGroup>(new BsonDocument("TenantId", CurrentTenantId)));
            collection = _gatewayDb.Context.Database.GetCollection<ModelGroup>("llmgw_model_pools");
        }
        else
        {
            collection = _db.ModelGroups;
        }

        var result = await collection.UpdateOneAsync(
            Builders<ModelGroup>.Filter.And(filters),
            Builders<ModelGroup>.Update.Set("Models.$.HalfOpenLeaseUntil", now.AddSeconds(leaseSeconds)),
            cancellationToken: ct);
        if (result.ModifiedCount != 1)
            return null;

        candidate.HalfOpenLeaseUntil = now.AddSeconds(leaseSeconds);
        _logger.LogInformation(
            "[ModelResolver] 不可用成员进入自动半开验证: Pool={PoolId}, Model={ModelId}, LeaseSeconds={LeaseSeconds}",
            group.Id, candidate.ModelId, leaseSeconds);
        return candidate;
    }

    internal static bool IsHalfOpenEligible(ModelGroupItem member, DateTime now, DateTime cutoff)
        => member.HealthStatus == ModelHealthStatus.Unavailable
           && (!member.HalfOpenLeaseUntil.HasValue || member.HalfOpenLeaseUntil <= now)
           && ((member.ManualRecoveryAt.HasValue && member.ManualRecoveryAt <= now)
               || !member.LastFailedAt.HasValue
               || member.LastFailedAt <= cutoff);

    /// <summary>
    /// 这些模型类型在专属池不可用时必须**失败关闭**，不许降级到 legacy 直连兜底。
    ///
    /// 判据是「拿错模型会不会静默产出垃圾」：
    ///   - VideoGen / Asr：拿 chat 模型去生成视频/转写，请求形状根本不对，会炸——但炸得晚且难懂
    ///   - Embedding：**最危险的一个**。拿 chat 模型走 /embeddings，要么 404，要么某些
    ///     兼容层真的回一串数字。后者会写进向量库，余弦照算、不报任何错，只是检索结果全是噪音；
    ///     而且这批脏向量与正确向量混在同一个集合里，事后极难分辨。宁可当场拒绝。
    /// </summary>
    /// <summary>
    /// 「这个 AppCaller 有没有专属池绑定」的唯一判据：只看**配置里绑了没有**，
    /// 不看那些池现在还查不查得到。
    ///
    /// 绑定的池被删掉时，按 id 查回来是 0 条。若据此认定「没有专属绑定」，
    /// 上面的失败关闭判据（embedding / video-gen / asr）就整条失效——绑定明明在、
    /// 池没了，解析却一路降级到默认池、expectedModel 直连乃至 legacy，
    /// embedding 会拿到 chat 模型，写出一批从库里认不出来的垃圾向量。
    /// 绑定存在而池不可用，恰恰是该判据要拦的那一种，不是它的例外。
    /// </summary>
    internal static bool HasDedicatedBinding(IReadOnlyCollection<string>? boundGroupIds)
        => boundGroupIds is { Count: > 0 };

    internal static bool ShouldFailClosedWhenDedicatedPoolUnavailable(string modelType)
        => string.Equals(modelType, ModelTypes.VideoGen, StringComparison.OrdinalIgnoreCase)
           || string.Equals(modelType, ModelTypes.Asr, StringComparison.OrdinalIgnoreCase)
           || string.Equals(modelType, ModelTypes.Embedding, StringComparison.OrdinalIgnoreCase);

    private async Task<GatewayRegistryLookup> TryGetGatewayRegistryGroupsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct)
    {
        if (_gatewayDb is null || string.IsNullOrWhiteSpace(appCallerCode) || string.IsNullOrWhiteSpace(modelType))
        {
            return GatewayRegistryLookup.ConfigPlaneDown("gateway-registry-unavailable");
        }

        try
        {
            var records = _gatewayDb.Context.Database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers");
            var record = await records
                .Find(Builders<GatewayAppCallerRecord>.Filter.And(
                    Builders<GatewayAppCallerRecord>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                    Builders<GatewayAppCallerRecord>.Filter.Eq(x => x.AppCallerCode, appCallerCode),
                    Builders<GatewayAppCallerRecord>.Filter.Eq(x => x.RequestType, modelType)),
                    new FindOptions { Collation = GatewayAppCallerIdentity.Collation })
                .SortByDescending(x => x.UpdatedAt)
                .FirstOrDefaultAsync(ct);
            if (record is null)
            {
                return GatewayRegistryLookup.Empty();
            }

            var status = GatewayAppCallerPolicy.NormalizeStatus(record.Status);
            if (!GatewayAppCallerPolicy.AllowsTraffic(status))
                return GatewayRegistryLookup.Rejected(record.ModelPoolId, $"appcaller-status-{status}", status);

            var allowedPoolIds = (record.AllowedModelPoolIds ?? [])
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Select(id => id.Trim())
                .Distinct(StringComparer.Ordinal)
                .ToList();
            if (allowedPoolIds.Count > 0)
            {
                var defaultPoolId = record.DefaultModelPoolId?.Trim();
                if (string.IsNullOrWhiteSpace(defaultPoolId) || !allowedPoolIds.Contains(defaultPoolId, StringComparer.Ordinal))
                {
                    return GatewayRegistryLookup.BlockedStrict(
                        defaultPoolId,
                        "appcaller-default-pool-missing-or-outside-allowed-set",
                        status);
                }

                var groups = new List<ModelGroup>(allowedPoolIds.Count);
                foreach (var poolId in allowedPoolIds)
                {
                    var group = await FindGatewayOwnedOrMapModelPoolAsync(
                        poolId,
                        modelType,
                        ct,
                        allowMapFallback: false);
                    if (group is null)
                    {
                        _logger.LogWarning(
                            "[ModelResolver] GW appCaller 允许的模型池不存在或类型不匹配: AppCallerCode={Code}, ModelType={Type}, ModelPoolId={PoolId}",
                            appCallerCode, modelType, poolId);
                        return GatewayRegistryLookup.BlockedStrict(
                            defaultPoolId,
                            "appcaller-allowed-model-pool-not-found-in-gateway",
                            status);
                    }
                    groups.Add(group);
                }

                return GatewayRegistryLookup.FoundStrict(
                    defaultPoolId,
                    groups,
                    status,
                    record.AllowCrossPoolFallback);
            }

            if (!string.IsNullOrWhiteSpace(record.ModelPoolId))
            {
                var group = await FindGatewayOwnedOrMapModelPoolAsync(
                    record.ModelPoolId,
                    modelType,
                    ct,
                    allowMapFallback: false);
                if (group is null)
                {
                    _logger.LogWarning(
                        "[ModelResolver] GW appCaller 绑定的模型池不存在或类型不匹配: AppCallerCode={Code}, ModelType={Type}, Status={Status}, ModelPoolId={PoolId}",
                        appCallerCode, modelType, status, record.ModelPoolId);
                    return GatewayRegistryLookup.Blocked(
                        record.ModelPoolId,
                        "appcaller-model-pool-not-found-in-gateway",
                        status);
                }

                return GatewayRegistryLookup.Found(record.ModelPoolId, [group], status);
            }

            var defaultGroups = await FindGatewayOwnedDefaultModelPoolsAsync(modelType, ct);
            if (defaultGroups.Count == 0)
            {
                return GatewayRegistryLookup.Blocked(
                    null,
                    $"{status}-appcaller-missing-gateway-default-pool",
                    status);
            }

            return GatewayRegistryLookup.Found(defaultGroups[0].Id, defaultGroups, status);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "[ModelResolver] 读取 GW appCaller registry 失败: AppCallerCode={Code}, ModelType={Type}",
                appCallerCode, modelType);
            return GatewayRegistryLookup.ConfigPlaneDown("gateway-registry-read-failed");
        }
    }

    private async Task<List<ModelGroup>> FindGatewayOwnedDefaultModelPoolsAsync(
        string modelType,
        CancellationToken ct)
    {
        if (_gatewayDb is null)
            return [];

        var poolTypes = _gatewayDb.Context.Database.GetCollection<BsonDocument>("llmgw_model_pool_types");
        var type = await poolTypes.Find(Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TenantId", CurrentTenantId),
                Builders<BsonDocument>.Filter.Eq("Code", modelType)))
            .FirstOrDefaultAsync(ct);
        var gatewayPools = _gatewayDb.Context.Database.GetCollection<ModelGroup>("llmgw_model_pools");
        if (type is not null)
        {
            var defaultPoolId = type.TryGetValue("DefaultPoolId", out var pointer) && pointer.IsString
                ? pointer.AsString
                : string.Empty;
            if (string.IsNullOrWhiteSpace(defaultPoolId))
                return [];
            var authoritative = await gatewayPools.Find(Builders<ModelGroup>.Filter.And(
                    Builders<ModelGroup>.Filter.Eq("TenantId", CurrentTenantId),
                    Builders<ModelGroup>.Filter.Eq(g => g.Id, defaultPoolId),
                    Builders<ModelGroup>.Filter.Eq(g => g.ModelType, modelType)))
                .FirstOrDefaultAsync(ct);
            return authoritative is null ? [] : [authoritative];
        }
        return await gatewayPools
            .Find(Builders<ModelGroup>.Filter.And(
                Builders<ModelGroup>.Filter.Eq("TenantId", CurrentTenantId),
                Builders<ModelGroup>.Filter.Eq(g => g.ModelType, modelType),
                Builders<ModelGroup>.Filter.Eq(g => g.IsDefaultForType, true)))
            .SortBy(g => g.Priority)
            .ToListAsync(ct);
    }

    private async Task<ModelGroup?> FindGatewayOwnedOrMapModelPoolAsync(
        string modelPoolId,
        string modelType,
        CancellationToken ct,
        bool allowMapFallback = true)
    {
        if (_gatewayDb is not null)
        {
            var gatewayPools = _gatewayDb.Context.Database.GetCollection<ModelGroup>("llmgw_model_pools");
            var gatewayPool = await gatewayPools
                .Find(Builders<ModelGroup>.Filter.And(
                    Builders<ModelGroup>.Filter.Eq("TenantId", CurrentTenantId),
                    Builders<ModelGroup>.Filter.Eq(g => g.Id, modelPoolId),
                    Builders<ModelGroup>.Filter.Eq(g => g.ModelType, modelType)))
                .FirstOrDefaultAsync(ct);
            if (gatewayPool is not null)
            {
                _logger.LogDebug(
                    "[ModelResolver] GW-owned model pool 命中: ModelPoolId={PoolId}, ModelType={ModelType}",
                    modelPoolId, modelType);
                return gatewayPool;
            }
        }

        if (!allowMapFallback)
            return null;

        return await _db.ModelGroups
            .Find(g => g.Id == modelPoolId && g.ModelType == modelType)
            .FirstOrDefaultAsync(ct);
    }

    private async Task<LLMPlatform?> FindGatewayOwnedOrMapPlatformAsync(
        string? platformId,
        bool enabledOnly,
        CancellationToken ct,
        bool allowMapFallback = true)
    {
        if (string.IsNullOrWhiteSpace(platformId))
            return null;

        if (_gatewayDb is not null)
        {
            var gatewayPlatforms = _gatewayDb.Context.Database.GetCollection<LLMPlatform>("llmgw_platforms");
            var gatewayPlatform = await gatewayPlatforms
                .Find(Builders<LLMPlatform>.Filter.And(
                    Builders<LLMPlatform>.Filter.Eq("TenantId", CurrentTenantId),
                    Builders<LLMPlatform>.Filter.Eq(p => p.Id, platformId),
                    enabledOnly ? Builders<LLMPlatform>.Filter.Eq(p => p.Enabled, true) : Builders<LLMPlatform>.Filter.Empty))
                .FirstOrDefaultAsync(ct);
            if (gatewayPlatform is not null)
            {
                _logger.LogDebug(
                    "[ModelResolver] GW-owned platform 命中: PlatformId={PlatformId}, EnabledOnly={EnabledOnly}",
                    platformId, enabledOnly);
                return gatewayPlatform;
            }
        }

        if (!allowMapFallback)
            return null;

        return await _db.LLMPlatforms
            .Find(p => p.Id == platformId && (!enabledOnly || p.Enabled))
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// 这条池成员对应的模型记录，是不是**明确**被停用了。
    ///
    /// 只回答「有证据说它停用」，不回答「它是不是可用」：查不到记录、或文档根本没写
    /// Enabled 字段，一律返回 false。用 Eq(Enabled,false) 而不是「取回来再判」，
    /// 就是为了让缺字段的老文档天然不匹配——bool 反序列化会把缺字段读成 false，
    /// 那样会把一批从没被人停用过的成员误判成停用。
    /// </summary>
    /// <summary>
    /// 「池成员里存的这个 ModelId，对应哪一条模型文档」——**唯一判定源**。
    ///
    /// 三个别名都要认：池成员的 ModelId 是按 `ModelName ?? Name ?? _id` 存下来的
    /// （见 console-api 追加成员那两处），所以一个缺 ModelName 的模型文档，成员里存的
    /// 就是它的 Name。
    ///
    /// 这个判据曾经被抄成两份、各自漂移：停用检查认三个别名，而「GW 有没有权威记录」
    /// 那处只认两个。后果不是「少查到一条」——GW 里明明启用着、只填了 Name 的模型
    /// 查不到，就被当成「GW 没有权威记录」，于是放行 MAP 侧的停用判定；MAP 里若躺着
    /// 一份过期的停用副本，这个本来可用的候选就被跳过，整个池可能因此无路可走。
    /// 所以收敛成一处，谁也别再单独写一遍。
    /// </summary>
    private static FilterDefinition<LLMModel> PoolMemberIdMatch(string modelId)
        => Builders<LLMModel>.Filter.Or(
            Builders<LLMModel>.Filter.Eq(m => m.ModelName, modelId),
            Builders<LLMModel>.Filter.Eq(m => m.Name, modelId),
            Builders<LLMModel>.Filter.Eq(m => m.Id, modelId));

    private async Task<bool> IsPoolMemberModelExplicitlyDisabledAsync(
        string platformId,
        string modelId,
        CancellationToken ct,
        bool allowMapFallback = true)
    {
        var idMatch = PoolMemberIdMatch(modelId);

        if (_gatewayDb is not null)
        {
            var gatewayModels = _gatewayDb.Context.Database.GetCollection<LLMModel>("llmgw_models");
            var disabled = await gatewayModels
                .Find(Builders<LLMModel>.Filter.And(
                    Builders<LLMModel>.Filter.Eq("TenantId", CurrentTenantId),
                    Builders<LLMModel>.Filter.Eq(m => m.PlatformId, platformId),
                    Builders<LLMModel>.Filter.Eq(m => m.Enabled, false),
                    idMatch))
                .AnyAsync(ct);
            if (disabled) return true;
        }

        if (!allowMapFallback) return false;

        return await _db.LLMModels
            .Find(Builders<LLMModel>.Filter.And(
                Builders<LLMModel>.Filter.Eq(m => m.PlatformId, platformId),
                Builders<LLMModel>.Filter.Eq(m => m.Enabled, false),
                idMatch))
            .AnyAsync(ct);
    }

    private async Task<LLMModel?> FindGatewayOwnedOrMapModelAsync(
        string platformId,
        string modelId,
        CancellationToken ct,
        bool allowMapFallback = true)
    {
        if (_gatewayDb is not null)
        {
            var gatewayModels = _gatewayDb.Context.Database.GetCollection<LLMModel>("llmgw_models");
            var gatewayModel = await gatewayModels
                .Find(Builders<LLMModel>.Filter.And(
                    Builders<LLMModel>.Filter.Eq("TenantId", CurrentTenantId),
                    Builders<LLMModel>.Filter.Eq(m => m.Enabled, true),
                    Builders<LLMModel>.Filter.Eq(m => m.PlatformId, platformId),
                    PoolMemberIdMatch(modelId)))
                .FirstOrDefaultAsync(ct);
            if (gatewayModel is not null)
            {
                _logger.LogDebug(
                    "[ModelResolver] GW-owned model 命中: PlatformId={PlatformId}, ModelId={ModelId}",
                    platformId, modelId);
                return gatewayModel;
            }
        }

        if (!allowMapFallback)
            return null;

        return await _db.LLMModels
            .Find(m => m.Enabled
                && m.PlatformId == platformId
                && (m.ModelName == modelId || m.Id == modelId))
            .FirstOrDefaultAsync(ct);
    }

    private IMongoCollection<ModelGroup> GetHealthModelGroups(ModelResolutionResult resolution)
    {
        if (IsGatewayOwnedResolution(resolution) && _gatewayDb is not null)
        {
            return _gatewayDb.Context.Database.GetCollection<ModelGroup>("llmgw_model_pools");
        }

        return _db.ModelGroups;
    }

    internal static bool IsGatewayOwnedResolution(ModelResolutionResult resolution)
        => string.Equals(resolution.ResolutionType, "GatewayRegistryPool", StringComparison.Ordinal);

    private bool DisableMapConfigFallbackForRegisteredAppCallers()
        => _config.GetValue<bool>("LlmGateway:DisableMapConfigFallbackForRegisteredAppCallers")
           || string.Equals(
               Environment.GetEnvironmentVariable("LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_REGISTERED_APP_CALLERS"),
               "true",
               StringComparison.OrdinalIgnoreCase)
           // 兼容已发布的旧变量；后续迁移完成后可移除。
           || _config.GetValue<bool>("LlmGateway:DisableMapConfigFallbackForActiveAppCallers")
           || string.Equals(
               Environment.GetEnvironmentVariable("LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS"),
               "true",
               StringComparison.OrdinalIgnoreCase);

    /// <param name="ConfigPlaneUnavailable">
    /// 配置面本身读不到（网关配置库缺失或读取抛错），区别于「配置读到了但配错了」。
    /// 两者混成一个失败原因，会让配置库一次抖动被报成「所有 AI 功能的模型池全报废」，
    /// 管理员按配置错误去排查，方向从一开始就是错的。
    /// </param>
    private sealed record GatewayRegistryLookup(
        List<ModelGroup> Groups,
        string? ModelPoolId,
        string? BlockReason,
        string? Status,
        bool TrafficRejected,
        bool StrictPoolContract,
        string? DefaultModelPoolId,
        bool AllowCrossPoolFallback,
        bool ConfigPlaneUnavailable = false)
    {
        public static GatewayRegistryLookup Empty() => new([], null, null, null, false, false, null, false);
        public static GatewayRegistryLookup Found(string? modelPoolId, List<ModelGroup> groups, string status)
            => new(groups, modelPoolId, null, status, false, false, modelPoolId, false);
        public static GatewayRegistryLookup FoundStrict(
            string defaultModelPoolId,
            List<ModelGroup> groups,
            string status,
            bool allowCrossPoolFallback)
            => new(groups, defaultModelPoolId, null, status, false, true, defaultModelPoolId, allowCrossPoolFallback);
        public static GatewayRegistryLookup Blocked(string? modelPoolId, string reason, string? status)
            => new([], modelPoolId, reason, status, false, false, modelPoolId, false);
        public static GatewayRegistryLookup BlockedStrict(string? modelPoolId, string reason, string? status)
            => new([], modelPoolId, reason, status, false, true, modelPoolId, false);
        public static GatewayRegistryLookup Rejected(string? modelPoolId, string reason, string status)
            => new([], modelPoolId, reason, status, true, false, modelPoolId, false);

        /// <summary>配置面不可读：基础设施故障，不是配置错误。</summary>
        public static GatewayRegistryLookup ConfigPlaneDown(string reason)
            => new([], null, reason, null, false, false, null, false, ConfigPlaneUnavailable: true);
    }

    internal static List<ModelGroup> SelectStrictPoolCandidates(
        IEnumerable<ModelGroup> groups,
        string? requestedPool,
        bool allowCrossPoolFallback)
    {
        if (string.IsNullOrWhiteSpace(requestedPool))
            return [];
        var orderedGroups = groups.ToList();
        var key = requestedPool.Trim();
        var selected = orderedGroups.FirstOrDefault(group =>
            string.Equals(group.Id, key, StringComparison.OrdinalIgnoreCase)
            || string.Equals(group.Code, key, StringComparison.OrdinalIgnoreCase)
            || string.Equals(group.Name, key, StringComparison.OrdinalIgnoreCase));
        if (selected is null)
            return [];
        return allowCrossPoolFallback
            ? new[] { selected }.Concat(orderedGroups.Where(group => group.Id != selected.Id)).ToList()
            : [selected];
    }

    private async Task<ModelExchange?> FindGatewayOwnedExchangeAsync(
        FilterDefinition<ModelExchange> filter,
        CancellationToken ct)
    {
        if (_gatewayDb is null)
            return null;

        var gatewayExchanges = _gatewayDb.Context.Database.GetCollection<ModelExchange>("llmgw_model_exchanges");
        var exchange = await gatewayExchanges.Find(Builders<ModelExchange>.Filter.And(
            Builders<ModelExchange>.Filter.Eq("TenantId", CurrentTenantId),
            filter)).FirstOrDefaultAsync(ct);
        if (exchange is not null)
        {
            _logger.LogDebug(
                "[ModelResolver] GW-owned exchange 命中: ExchangeId={ExchangeId}, Name={Name}",
                exchange.Id, exchange.Name);
        }
        return exchange;
    }

    private string CurrentTenantId
        => _requestContext?.Current?.TenantId is { Length: > 0 } tenantId ? tenantId : _internalTenantId;

    private async Task<AvailableModelPool> MapToAvailablePoolAsync(
        ModelGroup group,
        string resolutionType,
        bool isDedicated,
        bool isDefault,
        CancellationToken ct)
    {
        var models = new List<PoolModelInfo>();
        long? averageDurationMs = null;
        var recentTenRequests = 0;
        decimal? recentTenSuccessRatePercent = null;

        foreach (var model in group.Models ?? new List<ModelGroupItem>())
        {
            var platform = await FindGatewayOwnedOrMapPlatformAsync(model.PlatformId, enabledOnly: false, ct);

            models.Add(new PoolModelInfo
            {
                ModelId = model.ModelId,
                PlatformId = model.PlatformId,
                PlatformName = platform?.Name,
                Priority = model.Priority,
                HealthStatus = model.HealthStatus.ToString(),
                HealthScore = CalculateHealthScore(model)
            });
        }

        if (_gatewayDb is not null)
        {
            try
            {
                var logs = _gatewayDb.Context.Database.GetCollection<BsonDocument>("llmrequestlogs");
                var fb = Builders<BsonDocument>.Filter;
                var since = DateTime.UtcNow.AddDays(-7);
                var filter = fb.And(
                    fb.Eq("TenantId", CurrentTenantId),
                    fb.Eq("ModelPoolId", group.Id),
                    fb.Gte("StartedAt", since),
                    fb.In("Status", new[] { "succeeded", "failed" }));
                var stats = await logs.Aggregate()
                    .Match(filter)
                    .Group(new BsonDocument
                    {
                        { "_id", BsonNull.Value },
                        { "AverageDurationMs", new BsonDocument("$avg", "$DurationMs") },
                    })
                    .FirstOrDefaultAsync(ct);
                if (stats is not null
                    && stats.TryGetValue("AverageDurationMs", out var duration)
                    && !duration.IsBsonNull)
                {
                    averageDurationMs = duration.BsonType switch
                    {
                        BsonType.Int32 => duration.AsInt32,
                        BsonType.Int64 => duration.AsInt64,
                        BsonType.Double => (long)Math.Round(duration.AsDouble),
                        BsonType.Decimal128 => (long)Math.Round(Decimal128.ToDecimal(duration.AsDecimal128)),
                        _ => null,
                    };
                }
                var recentTen = await logs.Find(filter)
                    .Sort(Builders<BsonDocument>.Sort.Descending("StartedAt"))
                    .Project(Builders<BsonDocument>.Projection.Include("Status"))
                    .Limit(10)
                    .ToListAsync(ct);
                recentTenRequests = recentTen.Count;
                if (recentTenRequests > 0)
                {
                    recentTenSuccessRatePercent = Math.Round(
                        recentTen.Count(log => string.Equals(
                            log.TryGetValue("Status", out var status) && status.IsString ? status.AsString : null,
                            "succeeded",
                            StringComparison.Ordinal)) * 100m / recentTenRequests,
                        1,
                        MidpointRounding.AwayFromZero);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                // 日志统计是目录的可选增强信息；统计库故障不能阻断模型池发现与恢复操作。
                _logger.LogWarning(
                    ex,
                    "[ModelResolver] 模型池统计不可用，返回无统计指标的模型池: PoolId={PoolId}",
                    group.Id);
            }
        }

        return new AvailableModelPool
        {
            Id = group.Id,
            Name = group.Name,
            Code = group.Code,
            Priority = group.Priority,
            ResolutionType = resolutionType,
            IsDedicated = isDedicated,
            IsDefault = isDefault,
            Models = models,
            AverageDurationMs = averageDurationMs,
            RecentTenRequests = recentTenRequests,
            RecentTenSuccessRatePercent = recentTenSuccessRatePercent,
        };
    }

    private static int CalculateHealthScore(ModelGroupItem model)
    {
        return model.HealthStatus switch
        {
            ModelHealthStatus.Healthy => 100 - Math.Min(model.ConsecutiveFailures * 5, 20),
            ModelHealthStatus.Degraded => 50 - Math.Min(model.ConsecutiveFailures * 10, 40),
            ModelHealthStatus.Unavailable => 0,
            _ => 50
        };
    }

    internal static bool NeedsModelConfigFallback(ModelGroupItem model)
        => string.IsNullOrWhiteSpace(model.Protocol)
           || model.Capabilities is null
           || model.Capabilities.Count == 0;

    #endregion
}

/// <summary>
/// 内存模型调度器（用于单元测试）
/// 允许注入 Mock 数据而无需数据库
/// </summary>
public class InMemoryModelResolver : IModelResolver
{
    private readonly List<LLMAppCaller> _appCallers = new();
    private readonly List<ModelGroup> _modelGroups = new();
    private readonly List<LLMPlatform> _platforms = new();
    private readonly Dictionary<string, string> _apiKeys = new();

    // InMemory 与生产 ModelResolver 共用同一个专属绑定判据，避免测试路径重新定义语义。
    private static bool HasDedicatedBinding(IReadOnlyCollection<string>? boundGroupIds)
        => ModelResolver.HasDedicatedBinding(boundGroupIds);

    /// <summary>
    /// 添加 AppCaller 配置
    /// </summary>
    public InMemoryModelResolver WithAppCaller(LLMAppCaller appCaller)
    {
        _appCallers.Add(appCaller);
        return this;
    }

    /// <summary>
    /// 添加模型池
    /// </summary>
    public InMemoryModelResolver WithModelGroup(ModelGroup group)
    {
        _modelGroups.Add(group);
        return this;
    }

    /// <summary>
    /// 添加平台配置
    /// </summary>
    public InMemoryModelResolver WithPlatform(LLMPlatform platform, string? apiKey = null)
    {
        _platforms.Add(platform);
        if (!string.IsNullOrWhiteSpace(apiKey))
            _apiKeys[platform.Id] = apiKey;
        return this;
    }

    private readonly List<LLMModel> _legacyModels = new();

    /// <summary>
    /// 添加 legacy 直连模型（IsMain/IsIntent/IsVision/IsImageGen 标记）。
    /// 镜像生产 ModelResolver 的 legacy 兜底，供未迁移到 ModelGroups 的场景测试。
    /// </summary>
    public InMemoryModelResolver WithLegacyModel(LLMModel model, string? apiKey = null)
    {
        _legacyModels.Add(model);
        if (!string.IsNullOrWhiteSpace(model.PlatformId) && !string.IsNullOrWhiteSpace(apiKey))
            _apiKeys[model.PlatformId!] = apiKey!;
        return this;
    }

    private LLMModel? FindLegacyModel(string modelType) => modelType.ToLowerInvariant() switch
    {
        "chat" => _legacyModels.FirstOrDefault(m => m.IsMain && m.Enabled),
        "intent" => _legacyModels.FirstOrDefault(m => m.IsIntent && m.Enabled),
        "vision" => _legacyModels.FirstOrDefault(m => m.IsVision && m.Enabled),
        "generation" => _legacyModels.FirstOrDefault(m => m.IsImageGen && m.Enabled),
        _ => null
    };

    public Task<ModelResolutionResult> ResolveAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null,
        CancellationToken ct = default)
    {
        // Step 1: 查找 AppCaller
        var appCaller = _appCallers.FirstOrDefault(a => a.AppCode == appCallerCode);
        List<ModelGroup>? candidateGroups = null;
        var hasDedicatedBinding = false;
        string resolutionType = "NotFound";

        var platformId = pinnedPlatformId?.Trim();
        var modelId = pinnedModelId?.Trim();
        if (!string.IsNullOrWhiteSpace(platformId) || !string.IsNullOrWhiteSpace(modelId))
        {
            if (string.IsNullOrWhiteSpace(platformId) || string.IsNullOrWhiteSpace(modelId))
            {
                return Task.FromResult(ModelResolutionResult.NotFound(expectedModel ?? modelId,
                    "PinnedModel 调用必须同时提供 pinnedPlatformId 与 pinnedModelId",
                    GatewayRouteFailure.RouteConfigIncompatible,
                    "pinned-arguments",
                    appCallerCode));
            }

            var platform = _platforms.FirstOrDefault(p => p.Id == platformId && p.Enabled);
            var model = _legacyModels.FirstOrDefault(m => m.Enabled
                && m.PlatformId == platformId
                && (m.ModelName == modelId || m.Id == modelId));

            if (platform == null || model == null)
            {
                return Task.FromResult(ModelResolutionResult.NotFound(expectedModel ?? modelId,
                    $"PinnedModel 模型不存在或未启用: platform={platformId}, model={modelId}",
                    GatewayRouteFailure.RouteConfigIncompatible,
                    "pinned-model",
                    appCallerCode));
            }

            _apiKeys.TryGetValue(platform.Id, out var apiKey);
            return Task.FromResult(ModelResolutionResult.FromPinned(expectedModel ?? model.ModelName, model, platform, apiKey));
        }

        if (appCaller != null)
        {
            var requirement = appCaller.ModelRequirements
                .FirstOrDefault(r => r.ModelType == modelType);

            if (HasDedicatedBinding(requirement?.ModelGroupIds))
            {
                // 与生产 ModelResolver 共用同一个判据函数，不再各判一次。
                hasDedicatedBinding = true;

                // Step 2: 专属模型池
                candidateGroups = _modelGroups
                    .Where(g => requirement.ModelGroupIds.Contains(g.Id))
                    .OrderBy(g => g.Priority)
                    .ToList();

                if (candidateGroups.Count > 0)
                {
                    resolutionType = "DedicatedPool";
                }
            }
        }

        // Step 3: 默认模型池
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            candidateGroups = _modelGroups
                .Where(g => g.ModelType == modelType && g.IsDefaultForType)
                .OrderBy(g => g.Priority)
                .ToList();

            if (candidateGroups.Count > 0)
                resolutionType = "DefaultPool";
        }

        // Step 5: 无 dedicated/default 池 → legacy 直连兜底（镜像生产 ModelResolver）。
        if (candidateGroups == null || candidateGroups.Count == 0)
        {
            var legacy = FindLegacyModel(modelType);
            if (legacy != null)
            {
                var legacyPlatform = _platforms.FirstOrDefault(p => p.Id == legacy.PlatformId && p.Enabled);
                if (legacyPlatform != null)
                {
                    _apiKeys.TryGetValue(legacyPlatform.Id, out var legacyKey);
                    return Task.FromResult(ModelResolutionResult.FromLegacy(expectedModel, legacy, legacyPlatform, legacyKey));
                }
            }
            return Task.FromResult(ModelResolutionResult.NotFound(expectedModel,
                $"未找到可用模型: AppCallerCode={appCallerCode}, ModelType={modelType}",
                GatewayRouteFailure.ModelPoolEmpty,
                "pool-candidates-empty",
                appCallerCode));
        }

        // Step 6: 从模型池选择
        var resolvedPoolCandidates = new List<ModelResolutionResult>();
        var allowProviderRetryCandidates = string.IsNullOrWhiteSpace(expectedModel);
        var (preferredGroup, preferredItem) = FindPreferredModelForInMemory(candidateGroups, expectedModel);
        var orderedGroups = preferredGroup != null
            ? new[] { preferredGroup }.Concat(candidateGroups.Where(g => g.Id != preferredGroup.Id)).ToList()
            : candidateGroups;
        foreach (var group in orderedGroups)
        {
            var selectedModels = preferredGroup != null && group.Id == preferredGroup.Id
                ? (preferredItem is null ? [] : new List<ModelGroupItem> { preferredItem })
                : group.Models?
                    .Where(m => m.HealthStatus != ModelHealthStatus.Unavailable)
                    .OrderBy(m => m.HealthStatus == ModelHealthStatus.Healthy ? 0 : 1)
                    .ThenBy(m => m.Priority)
                    .ToList() ?? [];
            if (!allowProviderRetryCandidates && selectedModels.Count > 1)
                selectedModels = [selectedModels[0]];

            if (selectedModels.Count == 0)
                continue;

            foreach (var selectedModel in selectedModels)
            {
                var platform = _platforms.FirstOrDefault(p => p.Id == selectedModel.PlatformId && p.Enabled);
                if (platform == null)
                    continue;

                _apiKeys.TryGetValue(platform.Id, out var apiKey);
                var modelConfig = FindModelConfigForInMemory(selectedModel);
                resolvedPoolCandidates.Add(ModelResolutionResult.FromPool(
                    resolutionType, expectedModel, selectedModel, group, platform, apiKey, modelConfig));
                if (!allowProviderRetryCandidates)
                    return Task.FromResult(resolvedPoolCandidates[0]);
            }
        }

        if (resolvedPoolCandidates.Count > 0)
        {
            var selected = resolvedPoolCandidates[0];
            if (resolvedPoolCandidates.Count > 1)
                selected.RetryCandidates = resolvedPoolCandidates.Skip(1).ToList();
            return Task.FromResult(selected);
        }

        // 与生产 ModelResolver 共用同一个「空池 vs 全熔断」判据，测试路径不得另立语义。
        var poolFailureCode = candidateGroups.All(g => (g.Models?.Count ?? 0) == 0)
            ? GatewayRouteFailure.ModelPoolEmpty
            : GatewayRouteFailure.ModelPoolAllUnavailable;
        var poolFailureStage = poolFailureCode == GatewayRouteFailure.ModelPoolEmpty
            ? "pool-membership"
            : "pool-health";

        // 池存在但全部不可用 → legacy 直连降级（镜像生产 ModelResolver）。
        if (hasDedicatedBinding && ModelResolver.ShouldFailClosedWhenDedicatedPoolUnavailable(modelType))
        {
            return Task.FromResult(ModelResolutionResult.NotFound(expectedModel,
                $"模型池内所有模型不可用: AppCallerCode={appCallerCode}, ModelType={modelType}",
                poolFailureCode,
                poolFailureStage,
                appCallerCode));
        }

        // 池存在但全部不可用 → legacy 直连降级（镜像生产 ModelResolver）。
        var fallbackLegacy = FindLegacyModel(modelType);
        if (fallbackLegacy != null)
        {
            var fbPlatform = _platforms.FirstOrDefault(p => p.Id == fallbackLegacy.PlatformId && p.Enabled);
            if (fbPlatform != null)
            {
                _apiKeys.TryGetValue(fbPlatform.Id, out var fbKey);
                var originalPool = candidateGroups.FirstOrDefault();
                return Task.FromResult(new ModelResolutionResult
                {
                    Success = true,
                    ResolutionType = "Legacy",
                    ExpectedModel = expectedModel,
                    ActualModel = fallbackLegacy.ModelName,
                    ActualPlatformId = fallbackLegacy.PlatformId ?? string.Empty,
                    ActualPlatformName = fbPlatform.Name,
                    PlatformType = fbPlatform.PlatformType,
                    ApiUrl = fallbackLegacy.ApiUrl ?? fbPlatform.ApiUrl,
                    ApiKey = fbKey,
                    HealthStatus = "Healthy",
                    PlatformMaxConcurrency = fbPlatform.MaxConcurrency,
                    ModelMaxConcurrency = fallbackLegacy.MaxConcurrency,
                    IsFallback = true,
                    FallbackReason = $"模型池 '{originalPool?.Name}' 中所有模型不可用，回退到直连模型",
                    OriginalPoolId = originalPool?.Id,
                    OriginalPoolName = originalPool?.Name
                });
            }
        }

        return Task.FromResult(ModelResolutionResult.NotFound(expectedModel,
            "模型池内所有模型不可用",
            poolFailureCode,
            poolFailureStage,
            appCallerCode));
    }

    private static (ModelGroup? group, ModelGroupItem? item) FindPreferredModelForInMemory(
        List<ModelGroup> groups,
        string? expectedModel)
    {
        if (groups.Count == 0 || string.IsNullOrWhiteSpace(expectedModel))
            return (null, null);

        var key = expectedModel.Trim();

        foreach (var group in groups)
        {
            var exact = group.Models?.FirstOrDefault(model =>
                model.HealthStatus != ModelHealthStatus.Unavailable &&
                string.Equals(model.ModelId, key, StringComparison.OrdinalIgnoreCase));
            if (exact != null)
                return (group, exact);
        }

        foreach (var group in groups)
        {
            var prefix = group.Models?.FirstOrDefault(model =>
                model.HealthStatus != ModelHealthStatus.Unavailable &&
                !string.IsNullOrWhiteSpace(model.ModelId) &&
                model.ModelId.StartsWith(key, StringComparison.OrdinalIgnoreCase));
            if (prefix != null)
                return (group, prefix);
        }

        foreach (var group in groups)
        {
            var matchByPool =
                string.Equals(group.Id, key, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(group.Name, key, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(group.Code, key, StringComparison.OrdinalIgnoreCase);
            if (!matchByPool)
                continue;

            var picked =
                group.Models?.FirstOrDefault(model => model.HealthStatus == ModelHealthStatus.Healthy)
                ?? group.Models?.FirstOrDefault(model => model.HealthStatus == ModelHealthStatus.Degraded);
            if (picked != null)
                return (group, picked);
        }

        return (null, null);
    }

    private LLMModel? FindModelConfigForInMemory(ModelGroupItem model)
        => _legacyModels.FirstOrDefault(m => m.Enabled
            && string.Equals(m.PlatformId, model.PlatformId, StringComparison.Ordinal)
            && (string.Equals(m.ModelName, model.ModelId, StringComparison.Ordinal)
                || string.Equals(m.Id, model.ModelId, StringComparison.Ordinal)));

    public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct = default)
    {
        var result = new List<AvailableModelPool>();

        // 专属池
        var appCaller = _appCallers.FirstOrDefault(a => a.AppCode == appCallerCode);
        if (appCaller != null)
        {
            var requirement = appCaller.ModelRequirements
                .FirstOrDefault(r => r.ModelType == modelType);

            if (requirement?.ModelGroupIds?.Count > 0)
            {
                var dedicatedGroups = _modelGroups
                    .Where(g => requirement.ModelGroupIds.Contains(g.Id))
                    .OrderBy(g => g.Priority);

                foreach (var group in dedicatedGroups)
                {
                    result.Add(MapToAvailablePool(group, "DedicatedPool", true, false));
                }

                if (result.Count > 0)
                    return Task.FromResult(result);
            }
        }

        // 默认池
        var defaultGroups = _modelGroups
            .Where(g => g.ModelType == modelType && g.IsDefaultForType)
            .OrderBy(g => g.Priority);

        foreach (var group in defaultGroups)
        {
            result.Add(MapToAvailablePool(group, "DefaultPool", false, true));
        }

        return Task.FromResult(result);
    }

    public Task RecordSuccessAsync(ModelResolutionResult resolution, CancellationToken ct = default)
    {
        // 内存版本：更新 Models 列表中的健康状态
        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId))
            return Task.CompletedTask;

        var group = _modelGroups.FirstOrDefault(g => g.Id == resolution.ModelGroupId);
        var model = group?.Models?.FirstOrDefault(m =>
            m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel);

        if (model != null)
        {
            model.ConsecutiveSuccesses++;
            model.ConsecutiveFailures = 0;
            model.HealthStatus = ModelHealthStatus.Healthy;
            model.LastSuccessAt = DateTime.UtcNow;
        }

        return Task.CompletedTask;
    }

    public Task RecordFailureAsync(ModelResolutionResult resolution, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId))
            return Task.CompletedTask;

        var group = _modelGroups.FirstOrDefault(g => g.Id == resolution.ModelGroupId);
        var model = group?.Models?.FirstOrDefault(m =>
            m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel);

        if (model != null)
        {
            model.ConsecutiveFailures++;
            model.ConsecutiveSuccesses = 0;
            model.HealthStatus = model.ConsecutiveFailures >= 5 ? ModelHealthStatus.Unavailable :
                                 model.ConsecutiveFailures >= 3 ? ModelHealthStatus.Degraded :
                                 ModelHealthStatus.Healthy;
            model.LastFailedAt = DateTime.UtcNow;
        }

        return Task.CompletedTask;
    }

    public Task RecordUnavailableAsync(ModelResolutionResult resolution, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(resolution.ModelGroupId))
            return Task.CompletedTask;

        var group = _modelGroups.FirstOrDefault(g => g.Id == resolution.ModelGroupId);
        var model = group?.Models?.FirstOrDefault(m =>
            m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel);

        if (model != null)
        {
            model.ConsecutiveFailures++;
            model.ConsecutiveSuccesses = 0;
            model.HealthStatus = ModelHealthStatus.Unavailable;
            model.LastFailedAt = DateTime.UtcNow;
        }

        return Task.CompletedTask;
    }

    private AvailableModelPool MapToAvailablePool(
        ModelGroup group,
        string resolutionType,
        bool isDedicated,
        bool isDefault)
    {
        return new AvailableModelPool
        {
            Id = group.Id,
            Name = group.Name,
            Code = group.Code,
            Priority = group.Priority,
            ResolutionType = resolutionType,
            IsDedicated = isDedicated,
            IsDefault = isDefault,
            Models = (group.Models ?? new List<ModelGroupItem>())
                .Select(m =>
                {
                    var platform = _platforms.FirstOrDefault(p => p.Id == m.PlatformId);
                    return new PoolModelInfo
                    {
                        ModelId = m.ModelId,
                        PlatformId = m.PlatformId,
                        PlatformName = platform?.Name,
                        Priority = m.Priority,
                        HealthStatus = m.HealthStatus.ToString(),
                        HealthScore = m.HealthStatus switch
                        {
                            ModelHealthStatus.Healthy => 100,
                            ModelHealthStatus.Degraded => 50,
                            _ => 0
                        }
                    };
                })
                .ToList()
        };
    }
}

/// <summary>
/// Exchange 模型中继常量
/// </summary>
public static class ModelResolverConstants
{
    /// <summary>
    /// Exchange 虚拟平台 ID（模型池中 Exchange 模型使用此 PlatformId）
    /// </summary>
    public const string ExchangePlatformId = "__exchange__";

    /// <summary>
    /// Exchange 虚拟平台显示名称
    /// </summary>
    public const string ExchangePlatformName = "模型中继 (Exchange)";
}
