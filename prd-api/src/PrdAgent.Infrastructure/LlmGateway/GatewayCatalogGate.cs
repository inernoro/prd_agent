using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 名录门的共享判据：要不要拦、以及某条网关模型过不过得了这道门。
///
/// 为什么非抽出来不可：这道门此前在三处各写了一遍——运行时解析（ModelResolver）、
/// 对外模型目录端点（/v1/models）、以及就绪探针。三份逐字相同的判据意味着三份各自漂移的
/// 可能，而它们一旦不一致，表现是最难查的那种：目录说这个模型可调、探针说这个部署可路由、
/// 真调用却回 MODEL_NOT_IN_CATALOG，三个地方各自为真（形状 3：判据分裂成多份然后各自漂移）。
///
/// 抽出来之后判据只有一处，改它三处同时改。
/// </summary>
public static class GatewayCatalogGate
{
    /// <summary>
    /// 配置上说要不要拦。降到 <c>observe</c> 就只记录不拦。
    ///
    /// 注意这只是**必要条件**：真的拦还要求控制台那几条补标记迁移跑完，见
    /// <see cref="MigrationsCompleteAsync"/>。两个条件缺一不可，任何一处只判其中一个
    /// 都会在迁移没跑完时误拦存量模型。
    /// </summary>
    public static bool ConfiguredToEnforce(IConfiguration? configuration)
        => !string.Equals(
            configuration?["LlmGateway:ModelCatalogGate"]?.Trim(),
            "observe",
            StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 控制台那几条存量补标记迁移是不是都留下了完成时间。
    /// 读不到、没读完、读失败一律按「没跑完」处理——退回只记录不拦，
    /// 不让一次控制面故障扩大成数据面故障（见 <see cref="GatewayCatalogMigrations"/>）。
    /// </summary>
    public static async Task<bool> MigrationsCompleteAsync(IMongoDatabase database, CancellationToken ct)
    {
        var migrations = database.GetCollection<BsonDocument>(GatewayCatalogMigrations.CollectionName);
        var done = await migrations.CountDocumentsAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.In("_id", GatewayCatalogMigrations.RequiredIds),
                Builders<BsonDocument>.Filter.Exists(GatewayCatalogMigrations.CompletedAtField)),
            cancellationToken: ct);
        return done >= GatewayCatalogMigrations.RequiredIds.Length;
    }

    /// <summary>两个条件一起判：配置说要拦，且补标记确实跑完了。</summary>
    public static async Task<bool> EnforcesAsync(
        IConfiguration? configuration,
        IMongoDatabase database,
        CancellationToken ct)
        => ConfiguredToEnforce(configuration) && await MigrationsCompleteAsync(database, ct);

    /// <summary>
    /// 一条网关模型文档过不过得了这道门：名字在名录里，或带着管理员显式放行的戳。
    /// </summary>
    public static bool Passes(BsonDocument? modelDocument)
    {
        if (modelDocument is null) return false;
        var name = modelDocument.GetValue("ModelName", BsonNull.Value) is { IsString: true } value
            ? value.AsString
            : string.Empty;
        return Passes(name, IsAllowedOutsideCatalog(modelDocument));
    }

    /// <summary>纯参数形态，供拿不到整份文档的地方直接判。</summary>
    public static bool Passes(string? modelName, bool allowedOutsideCatalog)
        => (!string.IsNullOrWhiteSpace(modelName) && GatewayModelCatalog.Contains(modelName))
            || allowedOutsideCatalog;

    /// <summary>放行标记只认真正的布尔 true，缺字段与别的类型一律不算放行。</summary>
    public static bool IsAllowedOutsideCatalog(BsonDocument document)
        => document.TryGetValue("AllowedOutsideCatalog", out var value) && value.IsBoolean && value.AsBoolean;

    /// <summary>
    /// 一条兑换所线路实际打给上游的那个别名。
    ///
    /// 线路自己覆盖的优先；没覆盖时运行时会回落到兑换所的主别名（ModelAlias），
    /// 所以判据也必须认同一个回落，否则「线路没写覆盖」这一种输入就绕过了整道门。
    /// </summary>
    public static string EffectiveExchangeModelId(ModelExchange exchange, string? upstreamModelId)
        => !string.IsNullOrWhiteSpace(upstreamModelId) ? upstreamModelId.Trim() : exchange.ModelAlias ?? string.Empty;

    /// <summary>
    /// 这个兑换所声明过这条别名，**而且那一条是启用着的**吗。
    ///
    /// 只比 ModelId 不够：兑换所整体启用着，管理员照样可以把里面某一条别名单独停掉。
    /// 不看那个开关的话，线路继续往一条已经被关掉的别名上发流量，而目录与就绪判据
    /// 都说它可用——「关了等于没关」，比没有这个开关更糟。
    /// 旧形态合成出来的条目一律 Enabled=true（见 ModelExchangeAccessors），所以这条不影响它们。
    /// </summary>
    public static bool ExchangeDeclares(ModelExchange exchange, string? modelId)
        => FindDeclared(exchange, modelId) is not null;

    /// <summary>找出那条别名。没声明、或声明了但被单独停掉，都返回 null。</summary>
    private static ExchangeModel? FindDeclared(ModelExchange exchange, string? modelId)
        => string.IsNullOrWhiteSpace(modelId)
            ? null
            : exchange.GetEffectiveModels().FirstOrDefault(item =>
                item.Enabled && string.Equals(item.ModelId, modelId, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// 名录外的这条别名有没有被放行。
    ///
    /// 旧形态兑换所（别名由 ModelAlias/ModelAliases 两个字符串字段合成，没有地方盖逐条标记）
    /// 整体视为放行：它们同样是管理员在逐条放行落地**之前**声明的，与名录门上线前已入库的
    /// 模型同一处境。控制台下一次写这个兑换所时会把它落成带标记的 Models。
    /// </summary>
    public static bool ExchangeAliasAllowedOutsideCatalog(ModelExchange exchange, string? modelId)
    {
        if (exchange.Models is null || exchange.Models.Count == 0) return true;
        return FindDeclared(exchange, modelId)?.AllowedOutsideCatalog == true;
    }

    /// <summary>
    /// 一条指向物理模型的线路，按它**实际会打出去的那个模型名**判这道门。
    ///
    /// 线路可以用 UpstreamModelId 覆盖上游模型名，而运行时判的就是覆盖之后那个名字
    /// （ApplyCatalogGateAsync judge 的是解析结果里的 ActualModel）。只判目标文档自己的名字，
    /// 就会出现：目标模型在名录里、覆盖成的那个不在，清单照样列出来，而真调用回
    /// MODEL_NOT_IN_CATALOG——「列出来就是让对方白调一次」，正是这道门要防的。
    ///
    /// <paramref name="sameNameDocsOnPlatform"/> 是库里同名（且同一个 Provider）的那些模型文档。
    /// 一条都查不到时属于「管不着」——那个名字不是网关模型库里的东西，这道门没有资格判它，
    /// 与运行时的 OutOfJurisdiction 同档，照旧放行。
    /// </summary>
    public static bool PhysicalRoutePasses(
        string? effectiveModelName,
        IReadOnlyCollection<BsonDocument> sameNameDocsOnPlatform,
        bool gateEnforces)
    {
        if (!gateEnforces) return true;
        if (!string.IsNullOrWhiteSpace(effectiveModelName)
            && GatewayModelCatalog.Contains(effectiveModelName))
        {
            return true;
        }
        if (sameNameDocsOnPlatform.Count == 0) return true;
        return sameNameDocsOnPlatform.Any(IsAllowedOutsideCatalog);
    }

    /// <summary>
    /// 从一批模型文档里挑出「这条线路该管的那几条」：同名（两个名字字段都认）、同一个 Provider。
    ///
    /// 这是运行时 <c>SelectCatalogDocs</c> 的同一套谓词，收在这里是因为消费方不止一个：
    /// 对外清单与就绪探针都要先把同名文档挑出来才谈得上判门。两处各自拼一个
    /// <c>"{平台}::{名字}"</c> 的键就已经出过事——键用原样大小写、查的时候用覆盖值的大小写，
    /// 大小写不一致时查不到，于是判成「管不着」放行，而运行时按归一化字段查得到、判拦
    /// （形状 6：判据读的值不是真正生效的那个）。挑选这一步一旦分家，键怎么拼就是一道暗缝。
    /// </summary>
    public static IReadOnlyList<BsonDocument> SelectSameNameDocs(
        IEnumerable<BsonDocument> docs,
        string? modelName,
        string? platformId)
    {
        var trimmed = (modelName ?? string.Empty).Trim();
        if (trimmed.Length == 0) return [];
        var normalized = trimmed.ToLowerInvariant();
        return docs.Where(doc =>
        {
            var matchesName = Text(doc, "ModelNameNormalized") == normalized || Text(doc, "ModelName") == trimmed;
            if (!matchesName) return false;
            return string.IsNullOrWhiteSpace(platformId) || Text(doc, "PlatformId") == platformId;
        }).ToList();

        // 字段不是字符串（历史脏数据）时当成空串而不是抛：判据在请求路径上，
        // 一条坏文档不该让整次调用炸掉。与运行时同源。
        static string Text(BsonDocument doc, string field)
            => doc.TryGetValue(field, out var value) && value.IsString ? value.AsString : string.Empty;
    }

    /// <summary>
    /// 一条兑换所线路过不过得了这道门：兑换所声明过这条别名，且别名在名录里或被放行。
    /// 名录门降档时只要求「声明过」——没声明的那种在任何档位下都不是这个兑换所的东西。
    /// </summary>
    public static bool ExchangeRoutePasses(
        ModelExchange exchange,
        string? upstreamModelId,
        bool gateEnforces)
    {
        var modelId = EffectiveExchangeModelId(exchange, upstreamModelId);
        if (!ExchangeDeclares(exchange, modelId)) return false;
        return !gateEnforces
            || Passes(modelId, ExchangeAliasAllowedOutsideCatalog(exchange, modelId));
    }
}
