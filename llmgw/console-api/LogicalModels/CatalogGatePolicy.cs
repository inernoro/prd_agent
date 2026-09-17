using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>
/// 名录门在**控制台这一侧**的镜像：要不要拦，以及一条线路过不过得了。
///
/// 权威定义在 <c>prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayCatalogGate.cs</c>
/// 与 <c>PrdAgent.Core/LlmGateway/GatewayCatalogMigrations.cs</c>（运行时解析出口、对外清单、
/// 就绪探针都直接引用它们）。本项目按既定架构不引用 PrdAgent.*，所以这里是一份镜像，
/// 由 <c>CatalogGatePolicyMirrorTests</c> 逐项对照。
///
/// 为什么发布闸也要判这道门：运行时在解析出口上会把名录外、又没盖放行标记的模型
/// 一律拒成 MODEL_NOT_IN_CATALOG。闸门不判的话，一条「模型启用、平台启用」却过不了名录门的线路
/// 会被算成可用——发布放行，而经这条线路的每一次请求都失败。
/// </summary>
public static class CatalogGatePolicy
{
    /// <summary>控制台记录一次性迁移的集合名。</summary>
    public const string MigrationCollectionName = "llmgw_migrations";

    /// <summary>只有它存在才算跑完（只有 ClaimedAt 说明认领了但没写完）。</summary>
    public const string CompletedAtField = "CompletedAt";

    /// <summary>
    /// 数据面有资格从「只记录」升到「真拦」所要求的那几条补标记迁移。
    /// 与权威侧 <c>GatewayCatalogMigrations.RequiredIds</c> 同一批，逐项对照守卫钉住。
    /// </summary>
    public static readonly string[] RequiredMigrationIds =
    [
        "model-catalog-grandfather-v1",
        "model-catalog-grandfather-v2-strict-vendor-prefix",
        "exchange-model-allowance-v1",
        "model-catalog-grandfather-v3-strict-punctuation",
        "model-catalog-grandfather-v4-strict-suffix",
    ];

    /// <summary>
    /// 这道门现在拦不拦。
    ///
    /// 权威判据是两半：配置没降到 observe，且这几条补标记迁移都跑完了。控制台读不到数据面
    /// 进程的配置（那是另一个容器的 IConfiguration），所以这里只判后一半。差别只在
    /// 「有人用 observe 降过档」这一种紧急情况下出现，那时这一侧会比运行时**严**
    /// （把一条实际能用的线路报成不可用）——宁可这样，也不能反过来替一条必失败的线路作保。
    /// </summary>
    public static async Task<bool> EnforcesAsync(IMongoCollection<BsonDocument> migrations)
    {
        var done = await migrations.CountDocumentsAsync(Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.In("_id", RequiredMigrationIds),
            Builders<BsonDocument>.Filter.Exists(CompletedAtField)));
        return done >= RequiredMigrationIds.Length;
    }

    /// <summary>
    /// 一条指向物理模型的线路过不过得了这道门。
    ///
    /// <paramref name="sameNameDocsOnPlatform"/> 是同一个 Provider 下、与实际上游名同名的那些文档。
    /// 一条都查不到属于「管不着」，与运行时的 OutOfJurisdiction 同档，照旧放行。
    /// </summary>
    public static bool PhysicalRoutePasses(
        string? effectiveModelName,
        IReadOnlyCollection<BsonDocument> sameNameDocsOnPlatform,
        bool gateEnforces)
    {
        if (!gateEnforces) return true;
        if (Provisioning.ModelCatalog.Contains(effectiveModelName)) return true;
        if (sameNameDocsOnPlatform.Count == 0) return true;
        return sameNameDocsOnPlatform.Any(x =>
            x.GetValue("AllowedOutsideCatalog", BsonNull.Value) is BsonBoolean allowed && allowed.Value);
    }

    /// <summary>一条兑换所线路过不过得了这道门：声明过、且名录内或那一条带着放行标记。</summary>
    public static bool ExchangeRoutePasses(BsonDocument exchange, string? upstreamModelId, bool gateEnforces)
    {
        var alias = ExchangeAliasPolicy.EffectiveAlias(exchange, upstreamModelId);
        if (!ExchangeAliasPolicy.Declares(exchange, alias)) return false;
        return !gateEnforces
            || Provisioning.ModelCatalog.Contains(alias)
            || ExchangeAliasPolicy.AliasAllowedOutsideCatalog(exchange, alias);
    }
}
