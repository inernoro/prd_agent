using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using System.Collections.Concurrent;
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

    /// <summary>补标记迁移的完成状态（进程级，按网关库名分桶）。见 CatalogGateEnforcesAsync。</summary>
    private static readonly ConcurrentDictionary<string, (bool Complete, DateTime CheckedAt)> CatalogMigrationState = new();

    /// <summary>
    /// 还没完成时的重查间隔：控制台可能晚几十秒才起来，不能一直按第一次的结论走。
    /// 可由 `LlmGateway:ModelCatalogGateRecheckSeconds` 调整（默认 30 秒）——
    /// 它只影响「多久回头再问一次库」，不参与判据本身。
    /// </summary>
    private readonly TimeSpan _catalogMigrationRecheckInterval;

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
        _catalogGateEnforces = GatewayCatalogGate.ConfiguredToEnforce(config);
        _catalogMigrationRecheckInterval =
            int.TryParse(config["LlmGateway:ModelCatalogGateRecheckSeconds"], out var recheckSeconds) && recheckSeconds >= 0
                ? TimeSpan.FromSeconds(recheckSeconds)
                : TimeSpan.FromSeconds(30);
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
        // 钉了具体成员的请求不许在门内换人：用户点名要 A，给他 B 就是「选 A 给 B」，
        // 那是本仓库专门立过规矩要防的事（llm-gateway 规则 1/2）。宁可如实报这条钉住的用不了。
        return await ApplyCatalogGateAsync(
            resolved, appCallerCode, allowPromotion: string.IsNullOrWhiteSpace(pinnedModelId), ct);
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
        bool allowPromotion,
        CancellationToken ct)
    {
        if (!resolved.Success) return resolved;

        // 主选与整条重试链一次取回。逐个判的话，一个成员全是名录外私有模型的大池
        // （真实租户上有两百多个成员）会在打上游之前先串行做上百次带索引的读——
        // 判据没错，代价错了。名录内的成员在 JudgeAsync 开头就返回，本来就不进这一批。
        var gateTargets = new List<ModelResolutionResult> { resolved };
        if (resolved.RetryCandidates is { Count: > 0 }) gateTargets.AddRange(resolved.RetryCandidates);
        var batch = await PrefetchCatalogDocsAsync(gateTargets, ct);

        /*
          「能不能拦」要现问，而且只在真要拦的时候才问：配置写着 enforce 只是意愿，
          真凭据是控制台那几条补标记迁移跑完了没有（见 CatalogGateEnforcesAsync）。
          放在这里而不是方法开头，是因为绝大多数请求全在名录内，一条都不会被拦，
          不该为它们多问一次库。
        */
        bool? enforcesCache = null;
        async Task<bool> EnforcesAsync()
        {
            enforcesCache ??= await CatalogGateEnforcesAsync(ct);
            return enforcesCache.Value;
        }

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
                    var enforcesForCandidate = await EnforcesAsync();
                    _logger.LogWarning(
                        "[ModelResolver] 重试候选不在名录且未放行（名录门={Gate}）: AppCallerCode={Code}, Model={Model}, PlatformId={PlatformId}",
                        enforcesForCandidate ? "enforce/已摘除" : "observe/仍保留",
                        appCallerCode, candidate.ActualModel ?? "(空)", candidate.ActualPlatformId ?? "(空)");
                    if (!enforcesForCandidate) kept.Add(candidate);
                }
                resolved.RetryCandidates = kept;
            }
            return resolved;
        }

        var enforces = await EnforcesAsync();
        _logger.LogError(
            "[ModelResolver] 选中的模型不在内置名录且没有放行标记（名录门={Gate}）: "
            + "AppCallerCode={Code}, Model={Model}, PlatformId={PlatformId}, ResolutionType={Type}, Pool={Pool}",
            enforces ? "enforce/已拒绝" : "observe/仅记录未拦截",
            appCallerCode,
            resolved.ActualModel ?? "(空)",
            resolved.ActualPlatformId ?? "(空)",
            resolved.ResolutionType,
            resolved.ModelGroupId ?? "(无)");

        // observe 档（配置降档，或补标记还没跑完）：日志已经把该点名的都点了，请求照常放行——
        // 这一档存在的意义就是「先看清存量有多少会被拦」，拦下来就看不成了。
        if (!enforces) return resolved;

        /*
          主选被拦下，不等于这次请求就该失败。

          重试链是解析器**已经算好**的同池候选，池里混进一个名录外未放行的成员，
          若因此让整条链一起失败，就是把「一个成员的问题」放大成「这条 appCaller 的功能不可用」——
          `llm-gateway.md` 规则 4 明令禁止（单成员失败只更新该成员健康，不得关停整条功能）。
          所以这里先看链上还有没有过得了门的成员：有就把第一个顶上来当主选，
          剩下过门的仍留作重试链；一个都过不了，才是真的没有可用成员，那时再报 NotFound。
        */
        if (allowPromotion && resolved.RetryCandidates is { Count: > 0 })
        {
            var allowedCandidates = new List<ModelResolutionResult>();
            foreach (var candidate in resolved.RetryCandidates)
            {
                if (await JudgeAsync(candidate.ActualModel, candidate.ActualPlatformId, ct, batch) != CatalogVerdict.Blocked)
                    allowedCandidates.Add(candidate);
            }

            if (allowedCandidates.Count > 0)
            {
                var promoted = allowedCandidates[0];
                promoted.RetryCandidates = allowedCandidates.Skip(1).ToList();
                _logger.LogWarning(
                    "[ModelResolver] 主选被名录门拦下，改用重试链里第一个过门的成员: "
                    + "AppCallerCode={Code}, Blocked={Blocked}, Promoted={Promoted}, 剩余候选={Rest}",
                    appCallerCode,
                    resolved.ActualModel ?? "(空)",
                    promoted.ActualModel ?? "(空)",
                    promoted.RetryCandidates.Count);
                return promoted;
            }
        }

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
    /// 这道门此刻有没有资格真拦。
    ///
    /// 配置写着 enforce 只是**意愿**；真凭据是控制台那几条「给存量补放行标记」的迁移跑完了没有。
    /// 两者跑在不同容器里、没有启动顺序（compose 里都只依赖 Mongo，serving 的就绪探针只看自己），
    /// 所以「控制台还没迁完或迁失败」和「数据面已经在拦」完全可能同时成立——那一刻存量模型
    /// 会集体收到 MODEL_NOT_IN_CATALOG，一次控制面故障就扩大成了数据面故障，
    /// 而 `llm-gateway.md` 规则 7 明令禁止这件事。所以补标记没做完就只记录、不拦。
    ///
    /// 读不到标记（没有网关库、查库失败）一律按「还没做完」处理：这道门是后加的，
    /// 它自己出问题时该退回原状，而不是把请求一起拖下水。
    ///
    /// 缓存放在进程级静态里而不是实例字段——解析器是 scoped，每个请求一个新实例，
    /// 实例字段缓存不住任何东西。按库名分桶，测试里多个临时库不会互相污染。
    /// 只有「已完成」是终态可以永久缓存：完成标记写下去就不会再撤销。
    /// </summary>
    private async Task<bool> CatalogGateEnforcesAsync(CancellationToken ct)
    {
        if (!_catalogGateEnforces) return false;
        if (_gatewayDb is null) return false;

        var databaseKey = _gatewayDb.Database.DatabaseNamespace.DatabaseName;
        if (CatalogMigrationState.TryGetValue(databaseKey, out var cached)
            && (cached.Complete || DateTime.UtcNow - cached.CheckedAt < _catalogMigrationRecheckInterval))
        {
            return cached.Complete;
        }

        var complete = false;
        try
        {
            complete = await GatewayCatalogGate.MigrationsCompleteAsync(_gatewayDb.Database, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ModelResolver] 读不到名录门的迁移完成标记，本轮按 observe 处理（只记录不拦）");
        }

        CatalogMigrationState[databaseKey] = (complete, DateTime.UtcNow);
        if (!complete)
        {
            _logger.LogWarning(
                "[ModelResolver] 名录门配置为 enforce，但控制台的存量补标记（{Ids}）还没有全部记下完成时间，"
                + "本轮只记录不拦截——先确认控制台已启动并完成迁移，否则存量模型会被误拦",
                string.Join(", ", GatewayCatalogMigrations.RequiredIds));
        }

        return complete;
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
        // 同名谓词与内存挑选同一份（GatewayCatalogGate.SameNameFilter）：原始名字那一支忽略
        // 大小写，否则存量文档（没有归一化字段）里的 `Foo` 配上覆盖值 `foo` 查不到，
        // 判成「管不着」放行——该拦的漏了。
        var nameFilter = fb.And(
            fb.Eq("TenantId", CurrentTenantId),
            GatewayCatalogGate.SameNameFilter(trimmed));
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
                // 逐个名字用同一份谓词 Or 起来：批量这一支此前用 In 逐字比原始名字，
                // 与单条查询不同口径，存量文档换个大小写就只在其中一条路上查得到。
                GatewayCatalogGate.SameNameBatchFilter(names)))
            .Limit(CatalogBatchDocumentCap + 1)
            .ToListAsync(ct);
        return docs.Count > CatalogBatchDocumentCap ? null : docs;
    }

    /// <summary>
    /// 从预取结果里挑出「这一条该管的那些」：两个名字字段都认、给了 Provider 就只留那个 Provider 的。
    /// 与单条查询的谓词逐字对应。
    ///
    /// 谓词本体在 <see cref="GatewayCatalogGate.SelectSameNameDocs"/>：对外清单与就绪探针
    /// 也要挑同名文档才谈得上判门，各写一份的时候它们拼了个大小写敏感的键，
    /// 与这里的归一化匹配得出过相反结论（形状 3 + 形状 6）。这里只负责那个上限。
    /// </summary>
    private static List<BsonDocument> SelectCatalogDocs(
        IReadOnlyList<BsonDocument> batch,
        string modelName,
        string? platformId)
        => GatewayCatalogGate.SelectSameNameDocs(batch, modelName, platformId)
            .Take(CatalogPairDocumentCap)
            .ToList();

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
        // 读成 ModelExchange 而不是裸 BsonDocument，为的是用 GetEffectiveModels()——
        // 解析器选中这条模型时用的就是它。直接读 `Models` 数组会漏掉旧形态的兑换所
        // （别名只在 ModelAlias / ModelAliases 里，Models 为空），于是解析器选得出来、
        // 这道门却判它「没声明过」而拦下：又是拿变更前的状态去卡这次变更（形状 5）。
        var exchanges = _gatewayDb.Context.Database.GetCollection<ModelExchange>("llmgw_model_exchanges");
        var exchange = await exchanges
            .Find(Builders<ModelExchange>.Filter.And(
                Builders<ModelExchange>.Filter.Eq("TenantId", CurrentTenantId),
                Builders<ModelExchange>.Filter.Eq(x => x.Id, platformId)))
            .FirstOrDefaultAsync(ct);
        if (exchange is null) return null;

        // 兑换所里没有这条别名 = 它不是这个兑换所声明过的东西，一律拦下。
        // （解析器正常走下来不该出现这种情况；出现了说明有人在别处拼了个 PlatformId。）
        //
        // 判据本体在 GatewayCatalogGate：对外模型目录端点要拿同一套口径判「这条线路能不能列出来」，
        // 两边各写一份的话，清单会把一条运行时必拒的线路报成可调（形状 3）。
        if (!GatewayCatalogGate.ExchangeDeclares(exchange, modelId)) return CatalogVerdict.Blocked;

        if (exchange.Models is null || exchange.Models.Count == 0)
        {
            _logger.LogDebug(
                "[ModelResolver] 名录门：{Model} 来自旧形态兑换所 {ExchangeId}（别名在 ModelAlias/ModelAliases），"
                + "按逐条放行落地前的既有声明放行",
                modelId, platformId);
            return CatalogVerdict.Allowed;
        }

        // 名录内的在方法开头就放行了，走到这里的一定是名录外的：所以只看放行标记。
        // （不在这里再判一次名录——那一档永远为假，读的人会以为它在起作用。）
        return GatewayCatalogGate.ExchangeAliasAllowedOutsideCatalog(exchange, modelId)
            ? CatalogVerdict.Allowed
            : CatalogVerdict.Blocked;
    }

    private static bool IsAllowedOutsideCatalog(BsonDocument doc)
        => GatewayCatalogGate.IsAllowedOutsideCatalog(doc);

    /// <summary>
    /// 解析主流程：一个请求最终落到哪条线路。
    ///
    /// 2026-09-15 断流完成后删掉了模型池那一整套分支（原本 767 行）。池唯一比对外模型多出来
    /// 的能力是「按调用方兜底」，那一层已经落在 <see cref="GatewayLogicalModel.DefaultForAppCallerCodes"/>
    /// 上；删之前先把最后一个还绑池的调用方切了过来，并在部署上验过落点一模一样。
    ///
    /// 现在只有四档，顺序就是判据：
    ///   1. 调用方放不放行 —— 不放行当场结构化失败，不往下猜
    ///   2. 走对外模型目录 —— 点名走点名的，不点名走两层默认（先谁认领了它，再这个用途的默认）
    ///   3. 钉死了具体上游模型 —— 精确语义，不经目录，绝不静默换人
    ///   4. legacy 直连兜底 —— 仅限还没切到配置权威的租户，是退路不是主路
    /// </summary>
    private async Task<ModelResolutionResult> ResolveCoreAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null,
        CancellationToken ct = default)
    {
        var gatewayConfigRequired = !string.Equals(CurrentTenantId, _internalTenantId, StringComparison.Ordinal)
                                    || DisableMapConfigFallbackForRegisteredAppCallers();

        // 第一档：调用方放不放行。
        var caller = await TryGetGatewayAppCallerStatusAsync(appCallerCode, modelType, ct);
        if (caller.TrafficRejected)
        {
            _logger.LogWarning(
                "[ModelResolver] GW appCaller 状态拒绝真实流量: AppCallerCode={Code}, ModelType={Type}, Status={Status}, Reason={Reason}",
                appCallerCode, modelType, caller.Status ?? "missing", caller.BlockReason ?? "appcaller-traffic-rejected");
            return ModelResolutionResult.NotFound(expectedModel,
                $"GW appCaller 状态不允许真实流量: AppCallerCode={appCallerCode}, ModelType={modelType}, Status={caller.Status ?? "missing"}",
                GatewayRouteFailure.AppCallerPoolUnbound,
                "appcaller-registry-status",
                appCallerCode);
        }

        /*
          还带着模型池绑定的调用方：照常按对外模型解析，但**绝不静默**。

          池路由已经退场，`AllowedModelPoolIds` / `DefaultModelPoolId` / `ModelPoolId`
          这几个字段没有任何运行时消费方了。可控制台的 appCaller 页还留着那几个控件，
          页面写着「下次请求生效」——运维保存成功、以为自己把流量指到了某个池，实际
          这次解析走的是别的路。一次成功的保存变成了一个静默的空操作（Codex 第 53 轮 P1）。

          这里不改成 fail closed：池退场不该反过来把还在跑的调用方打挂（线上仍有两个
          带着这种残留字段）。要消灭的是「静默」而不是「放行」——所以照常解析，同时
          说清是谁的什么配置不再生效、于是这次按什么解析、下一步该做什么
          （external-cause-first：第一句给外因，技术细节靠后）。
        */
        var stalePoolBinding = caller?.StalePoolBinding;
        if (!string.IsNullOrWhiteSpace(stalePoolBinding))
        {
            _logger.LogWarning(
                "调用方 {AppCallerCode} 的配置里还绑着模型池 {PoolId}，而模型池路由已经退场："
                + "这次解析按「对外模型」走，那条绑定不起作用，无需处理；"
                + "要让它固定走某个模型，去模型页把那个模型「指定调用方」认领它。"
                + "技术细节：ModelType={ModelType} · 残留字段来自 llmgw_app_callers",
                appCallerCode, stalePoolBinding, modelType);
        }

        // 第二档：对外模型目录。钉死了具体上游模型时不走目录——那是精确语义，见第三档。
        if (string.IsNullOrWhiteSpace(pinnedPlatformId) && string.IsNullOrWhiteSpace(pinnedModelId))
        {
            var logical = await TryResolveLogicalModelAsync(appCallerCode, modelType, expectedModel, ct);
            if (logical is not null)
                return logical;

            if (string.IsNullOrWhiteSpace(expectedModel))
            {
                var byDefault = await TryResolveDefaultLogicalModelAsync(appCallerCode, modelType, ct);
                if (byDefault is not null)
                    return byDefault;
            }
        }

        // 第三档：钉死了具体上游模型。
        if (!string.IsNullOrWhiteSpace(pinnedPlatformId) || !string.IsNullOrWhiteSpace(pinnedModelId))
        {
            var pinned = await TryResolvePinnedModelAsync(
                appCallerCode, expectedModel, pinnedPlatformId, pinnedModelId, ct,
                allowMapFallback: !gatewayConfigRequired);
            if (pinned is not null)
                return pinned;
        }

        // 第四档：legacy 直连兜底。配置权威开启的租户没有这一档——它们的配置全在 GW 库里，
        // 读不到就该如实失败，而不是悄悄退回一份可能早就过时的 MAP 配置。
        if (!gatewayConfigRequired)
        {
            var legacyConfig = await TryResolveLegacyConfigFallbackAsync(modelType, expectedModel, ct);
            if (legacyConfig is not null)
                return legacyConfig;
        }

        // 都没有。配置面「读不到」与配置「配错了」必须分开：前者是基础设施故障（重试可能恢复），
        // 后者是配置问题（重试无用）。混成一个码会让配置库抖动被误判成全站模型报废。
        _logger.LogWarning(
            "[ModelResolver] 没有任何对外模型能接住这次请求: AppCallerCode={Code}, ModelType={Type}, Expected={Expected}, Status={Status}",
            appCallerCode, modelType, expectedModel ?? "(未点名)", caller.Status ?? "missing");
        return ModelResolutionResult.NotFound(expectedModel,
            $"没有对外模型能接住这次请求: AppCallerCode={appCallerCode}, ModelType={modelType}"
            + (string.IsNullOrWhiteSpace(expectedModel)
                ? "；请给这个用途设一个默认对外模型，或让某个模型「指定调用方」认领它。"
                : $"；请确认 {expectedModel} 在对外模型目录里、已启用、授权给了这个调用方，且有能接的线路。"),
            caller.ConfigPlaneUnavailable
                ? GatewayRouteFailure.GatewayConfigUnavailable
                : GatewayRouteFailure.AppCallerPoolUnbound,
            caller.ConfigPlaneUnavailable ? "gateway-config-plane" : "no-logical-model",
            appCallerCode);
    }

    /// <inheritdoc />
    public async Task<ModelResolutionResult> ResolveOfferingAsync(
        string appCallerCode,
        string modelType,
        string offeringId,
        CancellationToken ct = default)
    {
        var resolved = await ResolveOfferingCoreAsync(appCallerCode, modelType, offeringId, ct);
        // 调用方点名了某个 offering，门内不许换成别的：他要的就是这一个。
        return await ApplyCatalogGateAsync(resolved, appCallerCode, allowPromotion: false, ct);
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
    /// <inheritdoc />
    ///
    /// 应用侧「我能选哪些模型」的清单。2026-09-15 断流之后这里只剩一件事：把对外模型目录端出去。
    /// 原本 89 行里绝大多数是池的各级兜底（严格池 → GW 池 → MAP 专属池 → MAP 默认池），
    /// 池上零流量之后它们再也不会被走到。
    public async Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct = default)
    {
        var caller = await TryGetGatewayAppCallerStatusAsync(appCallerCode, modelType, ct);
        if (caller.TrafficRejected) return [];
        return await GetAvailableLogicalModelsAsPoolsAsync(appCallerCode, modelType, ct);
    }

    /// <inheritdoc />
    public async Task RecordSuccessAsync(ModelResolutionResult resolution, CancellationToken ct = default)
    {
        if (!string.IsNullOrWhiteSpace(resolution.OfferingId) && _gatewayDb is not null)
        {
            /*
              记账失败不许把一次**已经成功**的调用变成用户侧的失败。

              这里写的是健康台账，不是业务结果——上游已经回了，响应就在调用方手上等着返回。
              一次 Mongo 写抖动从这里抛出去，那次成功就成了 500。池成员那条路径一直是
              try/catch + 日志，Offering 这条漏了；断流之后 Offering 是主路径，
              于是这个洞从「兜底路径的边角」变成了「主路径的边角」（形状 10 的反面：
              该降级的地方没降级，把一个不影响结果的失败升级成了影响结果的失败）。
            */
            try
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
                    .Set(x => x.UpdatedAt, DateTime.UtcNow)
                    .Unset(x => x.HalfOpenLeaseUntil)
                    .Unset(x => x.ManualRecoveryAt);
                await offerings.UpdateOneAsync(filter, update, cancellationToken: ct);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex,
                    "[ModelResolver] 记录线路成功状态失败 Offering={OfferingId}（本次调用已成功，不受影响）",
                    resolution.OfferingId);
            }

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
            /*
              记账失败不许挡住**故障转移**。

              这里写的是健康台账，而调用方那边正等着「这条线路挂了，换下一条」的结论。
              一次 Mongo 写抖动从这里抛出去，LlmGateway 根本走不到挑下一条候选那一步——
              一次本来能自愈的失败，变成用户看到的失败。池成员那条路径一直是 try/catch + 日志，
              Offering 这条漏了；断流之后 Offering 是主路径，这个洞也就从边角挪到了主干。
            */
            try
            {
                var offerings = _gatewayDb.Context.Database.GetCollection<GatewayModelOffering>("llmgw_model_offerings");
                var filter = Builders<GatewayModelOffering>.Filter.And(
                    Builders<GatewayModelOffering>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                    Builders<GatewayModelOffering>.Filter.Eq(x => x.Id, resolution.OfferingId));
                // 先原子自增并取回自增后的真值，再据此升级状态。
                // 不能像以前那样先 Find 一次、拿旧快照 +1 算出状态再 Set：并发失败时各请求读到的
                // 是同一个自增前的值，谁最后落笔谁说了算，计数冲到几十而状态被写回健康，断路器
                // 就一直不跳，全部流量继续打向已经死掉的上游。
                var afterInc = await offerings.FindOneAndUpdateAsync(
                    filter,
                    Builders<GatewayModelOffering>.Update
                        .Inc(x => x.ConsecutiveFailures, 1)
                        .Set(x => x.ConsecutiveSuccesses, 0)
                        .Set(x => x.LastFailedAt, DateTime.UtcNow)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow)
                        .Unset(x => x.HalfOpenLeaseUntil)
                        // 人工恢复的那张通行证，一次失败就作废——池成员那条路径一直是这么做的
                        // （见下面 Models.$.ManualRecoveryAt 那处），Offering 这条漏了。
                        //
                        // 漏掉的后果不是「多试一次」：半开认领的条件里 ManualRecoveryAt <= now
                        // 是一条**独立**的放行项，与冷却时间并列。它留着，这条刚被证明还是坏的线路
                        // 就对**每一个**后续请求都满足认领条件，被反复抢去当队首探针，
                        // 配置的冷却期形同虚设——运维在控制台点一次「恢复」，等于把这条坏线路
                        // 永久钉在了队首，直到有人再去改一次配置。
                        .Unset(x => x.ManualRecoveryAt),
                    new FindOneAndUpdateOptions<GatewayModelOffering> { ReturnDocument = ReturnDocument.After },
                    ct);
                if (afterInc is null) return;
                var status = GatewayCircuitBreakerPolicy.ClassifyByFailures(afterInc.ConsecutiveFailures);
                if (!GatewayCircuitBreakerPolicy.IsEscalation(afterInc.HealthStatus, status))
                    return;
                // 升级这一步要带上「失败数还是当初那么多」这个条件。
                //
                // 自增与升级是两次写，中间可能挤进一次**成功**：成功那一路把 ConsecutiveFailures
                // 清零、把健康档写回 Healthy，而这里若只判 HealthStatus < status，就会把一个
                // 基于已经作废的失败数算出来的档位重新写回去——一条刚刚成功的线路被隔离整个冷却期，
                // 而它其实是好的（形状 5 的近亲：拿变更前的状态去 gate 一个会改变该状态的写）。
                //
                // 判据用 Gte 而不是等于：期间又失败了几次的话计数只会更高，这次升级照样该落；
                // 而清零过就一定小于它，条件不成立、这次写自然作废。降档由 Lt 那一条挡住，两者互补。
                await offerings.UpdateOneAsync(
                    Builders<GatewayModelOffering>.Filter.And(
                        filter,
                        Builders<GatewayModelOffering>.Filter.Lt(x => x.HealthStatus, status),
                        Builders<GatewayModelOffering>.Filter.Gte(x => x.ConsecutiveFailures, afterInc.ConsecutiveFailures)),
                    Builders<GatewayModelOffering>.Update
                        .Set(x => x.HealthStatus, status)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: ct);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex,
                    "[ModelResolver] 记录线路失败状态失败 Offering={OfferingId}（不影响本次故障转移）",
                    resolution.OfferingId);
            }

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

            var filter = Builders<ModelGroup>.Filter.And(
                Builders<ModelGroup>.Filter.Eq(g => g.Id, resolution.ModelGroupId),
                Builders<ModelGroup>.Filter.ElemMatch(g => g.Models,
                    m => m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel));

            // 与 Offering 分支同一口径：先原子自增拿真值，再单调升级状态。
            var afterInc = await modelGroups.FindOneAndUpdateAsync(
                filter,
                Builders<ModelGroup>.Update
                    .Inc("Models.$.ConsecutiveFailures", 1)
                    .Set("Models.$.ConsecutiveSuccesses", 0)
                    .Set("Models.$.LastFailedAt", DateTime.UtcNow)
                    .Unset("Models.$.HalfOpenLeaseUntil")
                    .Unset("Models.$.ManualRecoveryAt"),
                new FindOneAndUpdateOptions<ModelGroup> { ReturnDocument = ReturnDocument.After },
                ct);
            var updated = afterInc?.Models?.FirstOrDefault(m =>
                m.PlatformId == resolution.ActualPlatformId && m.ModelId == resolution.ActualModel);
            if (updated == null) return;

            var newFailures = updated.ConsecutiveFailures;
            var newStatus = GatewayCircuitBreakerPolicy.ClassifyByFailures(newFailures);
            if (GatewayCircuitBreakerPolicy.IsEscalation(updated.HealthStatus, newStatus))
            {
                // 同一个竞态，同一个条件：期间若有一次成功把计数清零，这次升级就不该落。
                await modelGroups.UpdateOneAsync(
                    Builders<ModelGroup>.Filter.And(
                        Builders<ModelGroup>.Filter.Eq(g => g.Id, resolution.ModelGroupId),
                        Builders<ModelGroup>.Filter.ElemMatch(g => g.Models,
                            m => m.PlatformId == resolution.ActualPlatformId
                                 && m.ModelId == resolution.ActualModel
                                 && m.HealthStatus < newStatus
                                 && m.ConsecutiveFailures >= newFailures)),
                    Builders<ModelGroup>.Update.Set("Models.$.HealthStatus", newStatus),
                    cancellationToken: ct);
            }

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
        /*
          隔离记账失败不许挡住故障转移，也不许把上游那次可诊断的失败变成一句 500。

          这个方法和 RecordSuccess / RecordFailure 是同一件事的第三条路——上一轮把那两条包进
          try/catch 时漏了它（形状 3 的老毛病：同一件事几个分支各写一套，其中一套没跟上）。
          漏的代价一模一样：调用方那边正等着「这条线路确定不可用，换下一条」的结论，
          一次 Mongo 写抖动从这里抛出去，网关走不到挑下一条候选那一步。
          而这条路上游给的往往是**确定性**的配置错误（密钥无效、模型名不存在），
          那种错误本该原样交给用户去修，不该被一次数据库问题换成「服务器错误」。
        */
        try
        {
            if (!string.IsNullOrWhiteSpace(resolution.OfferingId) && _gatewayDb is not null)
            {
                var offerings = _gatewayDb.Context.Database.GetCollection<GatewayModelOffering>("llmgw_model_offerings");
                var offeringFilter = Builders<GatewayModelOffering>.Filter.And(
                    Builders<GatewayModelOffering>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                    Builders<GatewayModelOffering>.Filter.Eq(x => x.Id, resolution.OfferingId));
                // 清掉半开痕迹与人工恢复标记：隔离是「这条线路当前确定不可用」的结论，
                // 不能让上一轮的租约或某次人工恢复继续把它当成待试探的候选。
                var offeringUpdate = Builders<GatewayModelOffering>.Update
                    .Inc(x => x.ConsecutiveFailures, 1)
                    .Set(x => x.ConsecutiveSuccesses, 0)
                    .Set(x => x.HealthStatus, ModelHealthStatus.Unavailable)
                    .Set(x => x.LastFailedAt, DateTime.UtcNow)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow)
                    .Unset(x => x.HalfOpenLeaseUntil)
                    .Unset(x => x.ManualRecoveryAt);
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
            // 同上：普通失败路径本来就清这两个字段，隔离路径漏清会让一个密钥彻底作废的成员
            // 在被人工恢复过一次之后，每轮租约到期就重新抢占一次真实用户请求的首发名额。
            var groupUpdate = Builders<ModelGroup>.Update
                .Inc("Models.$.ConsecutiveFailures", 1)
                .Set("Models.$.ConsecutiveSuccesses", 0)
                .Set("Models.$.HealthStatus", ModelHealthStatus.Unavailable)
                .Set("Models.$.LastFailedAt", DateTime.UtcNow)
                .Unset("Models.$.HalfOpenLeaseUntil")
                .Unset("Models.$.ManualRecoveryAt");
            await GetHealthModelGroups(resolution).UpdateOneAsync(groupFilter, groupUpdate, cancellationToken: ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "[ModelResolver] 记录隔离状态失败 Offering={OfferingId} Model={Model}（不影响本次故障转移）",
                resolution.OfferingId, resolution.ActualModel);
        }
    }

    #region Private Methods

    /// <summary>
    /// 视觉创作那三个调用方。它们在**模型选择器目录**上有两条特殊规则：只做操作的模型不列出来，
    /// 且目录里第一条标成默认。
    ///
    /// 这份名单曾经在 <c>GatewayRouteSelection</c> 里，因为那时它还兼着第二个职责——
    /// 「即便配了专属池也仍然认对外模型目录」，而那个职责随模型池在 2026-09-15 一起退场。
    /// 剩下的这一条纯粹是目录展示，解析判据不需要知道它，控制台面板也不需要，
    /// 所以名单搬回唯一的消费方，份数从 2 份（权威 + 控制台镜像）降到 1 份。
    ///
    /// 它仍然是一份**调用方特例漏进代码**的活标本（架构文档第 4 节：调用方与能力那两条轴
    /// 不该进代码）。真正的解法是让它变成调用方记录上的一个字段，那是后续的事。
    /// </summary>
    private static readonly HashSet<string> VisualCatalogCallers = new(StringComparer.Ordinal)
    {
        AppCallerRegistry.VisualAgent.Image.Text2Img,
        AppCallerRegistry.VisualAgent.Image.Img2Img,
        AppCallerRegistry.VisualAgent.Image.VisionGen,
    };

    internal static bool UsesVisualLogicalModelCatalog(string appCallerCode)
        => VisualCatalogCallers.Contains(appCallerCode);

    internal static bool IsLogicalOfferingAllowed(
        ModelResolutionResult resolution,
        IReadOnlyCollection<ModelGroup>? allowedGroups)
        => allowedGroups is null || allowedGroups.Any(group => group.Models.Any(member =>
            member.HealthStatus != ModelHealthStatus.Unavailable
            && string.Equals(member.PlatformId, resolution.ActualPlatformId, StringComparison.Ordinal)
            && string.Equals(member.ModelId, resolution.ActualModel, StringComparison.Ordinal)));

    private async Task<List<AvailableModelPool>> GetAvailableLogicalModelsAsPoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct,
        IReadOnlyCollection<ModelGroup>? allowedGroups = null)
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
            .ThenBy(x => x.PublicId)
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
            if (UsesVisualLogicalModelCatalog(appCallerCode)
                && GatewayCapabilityIds.IsOperationOnly(logical.PublicId, logical.Capabilities))
                continue;

            if (!offeringsByLogicalModel.TryGetValue(logical.Id, out var logicalOfferings))
                continue;

            // “启用且健康”只是控制面状态，不代表 Offering 指向的 Exchange、模型和平台仍然存在。
            // 选择器只能展示在当前租户与 appCaller 下至少能完整解析一个上游的逻辑模型，避免用户
            // 选中后才得到“模型不可用”。这里复用实际解析构建器，保证目录与执行链路采用同一规则。
            var hasResolvableOffering = false;
            foreach (var offering in OrderLogicalOfferings(logical, logicalOfferings))
            {
                var candidate = await TryBuildLogicalOfferingResolutionAsync(logical, offering, logical.PublicId, ct);
                if (candidate is null || !IsLogicalOfferingAllowed(candidate, allowedGroups)) continue;
                // 名录门也要过一遍。
                //
                // 上面那句注释说的是「目录与执行链路采用同一规则」，但它只覆盖了「解析得出来」
                // 这一半。执行链路还有第二道门：名录外又没盖放行标记的物理模型，
                // ApplyCatalogGateAsync 会拒掉。少了这一道，选择器里列出来的模型选中即失败
                // （MODEL_NOT_IN_CATALOG），而用户没做错任何事。
                // 对外的 /v1/models 上一轮已经补了这一道，应用侧这条清单是它的同类，一起补。
                if (await JudgeAsync(candidate.ActualModel, candidate.ActualPlatformId, ct) == CatalogVerdict.Blocked
                    && await CatalogGateEnforcesAsync(ct))
                {
                    continue;
                }
                hasResolvableOffering = true;
                break;
            }
            if (!hasResolvableOffering)
                continue;

            result.Add(new AvailableModelPool
            {
                Id = logical.Id,
                Name = logical.Name,
                Code = logical.PublicId,
                Description = logical.Description,
                Priority = logical.DisplayOrder,
                ResolutionType = "LogicalModel",
                IsDedicated = logical.AllowedAppCallerCodes.Count > 0,
                // 管理端 DisplayOrder 决定默认业务模型，前端不猜型号或池成员。
                IsDefault = UsesVisualLogicalModelCatalog(appCallerCode) && result.Count == 0,
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
        CancellationToken ct,
        IReadOnlyCollection<ModelGroup>? allowedGroups = null)
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
                    Builders<GatewayLogicalModel>.Filter.Eq(x => x.PublicId, key),
                    // 搬迁期的桥：`model_policy=pool` 这条契约还活着，serving 会把
                    // model_pool_id 塞进 expectedModel，而客户端存的是**池文档 ID**、
                    // 不是搬迁后的 PublicId。不认它的话这些请求一律查不到，又因为
                    // expectedModel 非空而跳过默认那一支，直接 MODEL_NOT_FOUND——
                    // 池退场把它们整条打断了。见 GatewayLogicalModel.MigratedFromPoolIds。
                    Builders<GatewayLogicalModel>.Filter.AnyEq(x => x.MigratedFromPoolIds, key))))
            .FirstOrDefaultAsync(ct);
        if (logical is null)
            return null;

        return await ResolveFromLogicalModelAsync(logical, appCallerCode, expectedModel, allowedGroups, ct);
    }

    /// <summary>
    /// 请求没点名模型时该用哪个对外模型。**两层**：先问「有没有模型认领了这个调用方」，
    /// 没有才回落到「这个用途的默认」。
    ///
    /// 这是「模型池并进模型」的接线点：池唯一比逻辑模型多出来的能力就是「当兜底」，
    /// 补上它之后池不再是另一种东西，只是这一行多了个标记。
    ///
    /// 解析不出来（没挂线路、能力不匹配、线路全熔断）时返回 null 而不是失败结果，
    /// 让调用方继续往下走（钉死的上游 / legacy 兜底）。
    /// 2026-09-15 删池之前这里回落的是模型池；池删了之后，都走不通就是如实失败。
    /// </summary>
    private async Task<ModelResolutionResult?> TryResolveDefaultLogicalModelAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct,
        IReadOnlyCollection<ModelGroup>? allowedGroups = null)
    {
        if (_gatewayDb is null) return null;

        var logicalModels = _gatewayDb.Context.Database.GetCollection<GatewayLogicalModel>("llmgw_logical_models");
        var fb = Builders<GatewayLogicalModel>.Filter;
        // 两层查询共用的那三个条件：同租户、启用着、用途对得上。
        var basics = fb.And(
            fb.Eq(x => x.TenantId, CurrentTenantId),
            fb.Eq(x => x.Enabled, true),
            fb.Eq(x => x.ModelType, modelType));

        // 第一层：有没有哪个模型认领了这个调用方。
        //
        // 这一层是模型池那个「按调用方兜底」能力的落点。少了它，把最后一个走池的调用方
        // 切过来时它会掉到全局默认上——换了模型，那不是断流是换药。
        // 两层都按 DisplayOrder/PublicId 排序：存量数据里万一有两个，取值确定而不是看运气。
        var logical = await logicalModels
            .Find(fb.And(basics, fb.AnyEq(x => x.DefaultForAppCallerCodes, appCallerCode)))
            .SortBy(x => x.DisplayOrder).ThenBy(x => x.PublicId)
            .FirstOrDefaultAsync(ct);

        // 第二层：这个用途的默认。
        logical ??= await logicalModels
            .Find(fb.And(basics, fb.Eq(x => x.IsDefaultForType, true)))
            .SortBy(x => x.DisplayOrder).ThenBy(x => x.PublicId)
            .FirstOrDefaultAsync(ct);
        if (logical is null) return null;

        var resolved = await ResolveFromLogicalModelAsync(logical, appCallerCode, logical.PublicId, allowedGroups, ct);
        if (resolved is null || resolved.Success) return resolved;

        _logger.LogWarning(
            "[ModelResolver] 默认模型解析失败: ModelType={Type}, Default={PublicId}, Reason={Reason}",
            modelType, logical.PublicId, resolved.ErrorMessage);
        return null;
    }

    private async Task<ModelResolutionResult?> ResolveFromLogicalModelAsync(
        GatewayLogicalModel logical,
        string appCallerCode,
        string? expectedModel,
        IReadOnlyCollection<ModelGroup>? allowedGroups,
        CancellationToken ct)
    {
        if (_gatewayDb is null) return null;

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
        // 刻意把「停用」「熔断」这两个条件从查询里拿掉，全量取回后交给
        // GatewayRouteSelection.SkipReason 判。原来写在查询条件里，等于同一个判据存在两份：
        // 一份是这里的 Mongo filter，一份是控制台面板要给人看的「为什么跳过这条」——
        // 两份必然漂移，而且漂了没人发现（形状 3）。一个对外模型下的线路是几十条量级，
        // 全量取回的代价可以忽略。
        var available = await offerings.Find(Builders<GatewayModelOffering>.Filter.And(
                Builders<GatewayModelOffering>.Filter.Eq(x => x.TenantId, CurrentTenantId),
                Builders<GatewayModelOffering>.Filter.Eq(x => x.LogicalModelId, logical.Id)))
            .ToListAsync(ct);

        var ordered = OrderLogicalOfferings(logical, available);
        var resolved = new List<ModelResolutionResult>();
        foreach (var offering in ordered)
        {
            var candidate = await TryBuildLogicalOfferingResolutionAsync(logical, offering, expectedModel, ct);
            if (candidate is not null && IsLogicalOfferingAllowed(candidate, allowedGroups))
                resolved.Add(candidate);
        }

        // 冷却期满后拿一条不可用 Offering 做半开试探，放在发送队列首位。
        // 没有这一步，GatewayRouteSelection 把熔断线路剔出队列就是一扇单向门：Offering 被摘掉
        // 之后再也拿不到一次成功来翻身，只能等人去控制台改密钥。租约保证同一时刻只有一个请求在试。
        // 它刻意不进那个纯函数——要抢租约、要写库。面板也因此不把它当成确定的下一跳。
        var halfOpen = await TryClaimHalfOpenOfferingAsync(logical, ct);
        if (halfOpen is not null)
        {
            var probe = await TryBuildLogicalOfferingResolutionAsync(logical, halfOpen, expectedModel, ct);
            if (probe is not null && IsLogicalOfferingAllowed(probe, allowedGroups))
                resolved.Insert(0, probe);
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

    /// <summary>
    /// 这次该按什么顺序发。判据本体在 <see cref="GatewayRouteSelection"/>——控制台的
    /// 「调用全貌」面板要回答同一个问题，两边必须是同一份判据，这里只做映射与转发。
    /// </summary>
    private List<GatewayModelOffering> OrderLogicalOfferings(
        GatewayLogicalModel logical,
        List<GatewayModelOffering> offerings)
    {
        var seedText = $"{_requestContext?.Current?.RequestId ?? Guid.NewGuid().ToString("N")}::{logical.Id}";
        var seed = BitConverter.ToUInt32(SHA256.HashData(Encoding.UTF8.GetBytes(seedText)), 0);
        var byId = offerings.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var queue = GatewayRouteSelection.Queue(
            offerings.Select(ToRouteCandidate).ToList(),
            GatewayRouteSelection.IsWeighted(logical.RoutingStrategy),
            seed);
        return queue.Select(x => byId[x.Id]).ToList();
    }

    /// <summary>
    /// Offering 映射成判据认识的形状。字段对不齐时镜像对照测试会红。
    ///
    /// TargetUsable 这里恒传 true：目标模型与上游是否启用，本方法拿不到，
    /// 由随后的 <see cref="TryBuildLogicalOfferingResolutionAsync"/> 用 requireEnabled 过滤
    /// （目标不可用时它返回 null，那条线路照样进不了候选，最终集合与在这里过滤等价）。
    /// 控制台那边拿得到，所以它会传真值——它必须说得出「为什么跳过这条」。
    /// </summary>
    internal static GatewayRouteSelection.RouteCandidate ToRouteCandidate(GatewayModelOffering offering)
        => new(offering.Id, offering.Priority, offering.Weight, (int)offering.HealthStatus, offering.Enabled,
            TargetUsable: true);

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
            // 兑换所整体启用着，不代表这条线路要打的那个别名还开着：管理员可以把里面某一条单独停掉。
            // 只判 Exchange.Enabled 的话，流量继续往一条被关掉的别名上发——「关了等于没关」。
            // 判据与目录、就绪那两处共用同一份（GatewayCatalogGate），不另写近似。
            if (requireEnabled && !GatewayCatalogGate.ExchangeDeclares(exchange, item.ModelId))
            {
                _logger.LogDebug(
                    "[ModelResolver] 兑换所 {ExchangeId} 里没有启用着的别名 {Model}，这条线路跳过",
                    exchange.Id, item.ModelId);
                return null;
            }
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

        // 价格从物理模型搬进这个合成条目。
        //
        // 池退场之前价格挂在池成员上，解析走池成员那条路，这一步不存在。现在线路指向的是
        // 物理模型文档，价格的唯一载体是它——不搬过来，ModelResolutionResult 的价格字段
        // （它读的是这个 item）就全是空，于是每一次调用都按「没配价」记账：币种判为过期、
        // 不进美元成本、不进预算，而日志里一个字都不会说（degradation-must-alarm）。
        item.InputPricePerMillion = model.InputPricePerMillion;
        item.OutputPricePerMillion = model.OutputPricePerMillion;
        item.CachedInputPricePerMillion = model.CachedInputPricePerMillion;
        item.CacheWritePricePerMillion = model.CacheWritePricePerMillion;
        item.PricePerCall = model.PricePerCall;
        item.PriceCurrency = model.PriceCurrency;
        item.PriceSource = model.PriceSource;
        item.PriceObservedAt = model.PriceObservedAt;
        // 最大输出 token 上限同理：FromPool 只读这个合成条目，**刻意不回落到物理模型**
        //（那条注释就在它上面：不覆盖池成员的价格与 MaxTokens）。不搬过来的话，
        // 模型页上填的「最大输出」保存成功、界面回显正常，而走对外模型的流量一个都不受它约束——
        // 又一个「填了不生效」的开关，比不能填更糟。
        //
        // 与价格是同一个形状，也是同一次疏忽：上一轮只搬了价格，没扫这个合成对象的其余字段
        // （形状 6 的那句「修完要横扫同类」）。
        item.MaxTokens = model.MaxTokens;
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




    /// <summary>
    /// 给逻辑模型认领一条半开 Offering。与模型池成员那套同源：条件写 + ModifiedCount 校验，
    /// 租约自带过期，所以多实例安全，且拿到租约的实例挂掉也不会把 Offering 永久锁死。
    /// </summary>
    private async Task<GatewayModelOffering?> TryClaimHalfOpenOfferingAsync(
        GatewayLogicalModel logical,
        CancellationToken ct)
    {
        if (_gatewayDb is null) return null;

        var now = DateTime.UtcNow;
        var cooldownSeconds = GatewayCircuitBreakerPolicy.ResolveHalfOpenAfterSeconds(
            _config.GetValue<int?>(GatewayCircuitBreakerPolicy.HalfOpenAfterSecondsKey));
        var leaseSeconds = GatewayCircuitBreakerPolicy.ResolveHalfOpenLeaseSeconds(
            _config.GetValue<int?>(GatewayCircuitBreakerPolicy.HalfOpenLeaseSecondsKey));
        var cutoff = now.AddSeconds(-cooldownSeconds);

        var offerings = _gatewayDb.Context.Database.GetCollection<GatewayModelOffering>("llmgw_model_offerings");
        var fb = Builders<GatewayModelOffering>.Filter;
        var claimed = await offerings.FindOneAndUpdateAsync(
            fb.And(
                fb.Eq(x => x.TenantId, CurrentTenantId),
                fb.Eq(x => x.LogicalModelId, logical.Id),
                fb.Eq(x => x.Enabled, true),
                fb.Eq(x => x.HealthStatus, ModelHealthStatus.Unavailable),
                fb.Or(
                    fb.Exists(x => x.HalfOpenLeaseUntil, false),
                    fb.Eq(x => x.HalfOpenLeaseUntil, null),
                    fb.Lte(x => x.HalfOpenLeaseUntil, now)),
                fb.Or(
                    fb.Lte(x => x.ManualRecoveryAt, now),
                    fb.Exists(x => x.LastFailedAt, false),
                    fb.Eq(x => x.LastFailedAt, null),
                    fb.Lte(x => x.LastFailedAt, cutoff))),
            Builders<GatewayModelOffering>.Update
                .Set(x => x.HalfOpenLeaseUntil, now.AddSeconds(leaseSeconds)),
            new FindOneAndUpdateOptions<GatewayModelOffering>
            {
                ReturnDocument = ReturnDocument.After,
                Sort = Builders<GatewayModelOffering>.Sort.Ascending(x => x.Priority),
            },
            ct);
        if (claimed is null) return null;

        _logger.LogInformation(
            "[ModelResolver] 不可用 Offering 进入自动半开验证: LogicalModel={PublicId}, Offering={OfferingId}, LeaseSeconds={LeaseSeconds}",
            logical.PublicId, claimed.Id, leaseSeconds);
        return claimed;
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


    /// <summary>
    /// 这个调用方此刻放不放行流量。
    ///
    /// 2026-09-15 之前这个方法叫 TryGetGatewayRegistryGroupsAsync，除了读状态还顺手把调用方
    /// 绑定的模型池全部加载出来（114 行）。断流之后没有调用方再绑池，它只剩下读状态这一件事。
    ///
    /// 读不到（没有网关库、查库失败）一律按「配置面不可用」返回，而不是按「不放行」——
    /// 这两件事的下一步完全不同：前者重试可能恢复，后者重试无用。
    /// </summary>
    private async Task<GatewayCallerStatus> TryGetGatewayAppCallerStatusAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct)
    {
        if (_gatewayDb is null || string.IsNullOrWhiteSpace(appCallerCode) || string.IsNullOrWhiteSpace(modelType))
            return new GatewayCallerStatus(false, null, "gateway-registry-unavailable", ConfigPlaneUnavailable: true);

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

            // 没登记过不等于不放行：这类调用方照样能点名一个公开的对外模型。
            if (record is null) return new GatewayCallerStatus(false, null, null);

            var stalePool = new[] { record.ModelPoolId, record.DefaultModelPoolId }
                .Concat(record.AllowedModelPoolIds ?? [])
                .FirstOrDefault(x => !string.IsNullOrWhiteSpace(x));

            var status = GatewayAppCallerPolicy.NormalizeStatus(record.Status);
            return GatewayAppCallerPolicy.AllowsTraffic(status)
                ? new GatewayCallerStatus(false, status, null, StalePoolBinding: stalePool)
                : new GatewayCallerStatus(true, status, $"appcaller-status-{status}", StalePoolBinding: stalePool);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "[ModelResolver] 读 GW appCaller 状态失败: AppCallerCode={Code}, ModelType={Type}",
                appCallerCode, modelType);
            return new GatewayCallerStatus(false, null, "gateway-registry-read-failed", ConfigPlaneUnavailable: true);
        }
    }

    /// <param name="TrafficRejected">明确不放行；配置面读不到时为 false，由 ConfigPlaneUnavailable 说明。</param>
    /// <param name="Status">归一化后的状态串；没登记过为 null。</param>
    /// <param name="BlockReason">不放行或读不到的原因码。</param>
    /// <param name="ConfigPlaneUnavailable">配置面读不到——是基础设施故障，不是配置问题。</param>
    private sealed record GatewayCallerStatus(
        bool TrafficRejected,
        string? Status,
        string? BlockReason,
        bool ConfigPlaneUnavailable = false,
        /// <summary>
        /// 这条 appCaller 还留着的模型池绑定。**只用来告警，不参与任何判定**——
        /// 池路由已经退场，留着它是为了把「你配的那个绑定不再生效」说出口，
        /// 而不是让它重新影响解析。
        /// </summary>
        string? StalePoolBinding = null);



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
    /// 成员发送顺序——**委托给权威判据**，不在这里另写一遍。
    ///
    /// 生产侧的池解析在 2026-09-15 断流后已整体删除，这个内存实现是它留下的化石：
    /// 150 条用例还挂在它身上，所以暂时留着（债务见 doc/debt.platform.llm-gateway.md）。
    /// 留着可以，但判据不许再分叉——Id 传补零下标保住原数组顺序。
    /// </summary>
    private static List<ModelGroupItem> OrderMembers(IReadOnlyList<ModelGroupItem>? members)
    {
        if (members is null || members.Count == 0) return [];
        var candidates = members
            .Select((m, i) => new GatewayRouteSelection.RouteCandidate(
                Id: i.ToString("D6"),
                Priority: m.Priority,
                Weight: 100,
                HealthStatus: (int)m.HealthStatus,
                Enabled: true))
            .ToList();
        return GatewayRouteSelection
            .Queue(candidates, weighted: false, seed: 0)
            .Select(x => members[int.Parse(x.Id)])
            .ToList();
    }

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
                : OrderMembers(group.Models);
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
