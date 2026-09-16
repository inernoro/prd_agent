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
}
