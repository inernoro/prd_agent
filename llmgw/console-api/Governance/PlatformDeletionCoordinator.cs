using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.Governance;

public enum PlatformDeletionScope
{
    GatewayOnly,
    MapOnly,
    GatewayAndMapSource,
    Ambiguous,
}

public sealed record PlatformDeletionTarget(
    string PlatformId,
    BsonDocument EffectiveDocument,
    BsonDocument? GatewayDocument,
    BsonDocument? MapSourceDocument,
    PlatformDeletionScope Scope);

public sealed record PlatformDeletionResult(
    bool GatewayDeleted,
    bool MapSourceDeleted);

public sealed class PlatformDeletionException : Exception
{
    public PlatformDeletionException(
        string message,
        string failureStage,
        bool gatewayDeleted,
        bool mapSourceDeleted,
        Exception? innerException = null)
        : base(message, innerException)
    {
        FailureStage = failureStage;
        GatewayDeleted = gatewayDeleted;
        MapSourceDeleted = mapSourceDeleted;
    }

    public string FailureStage { get; }
    public bool GatewayDeleted { get; }
    public bool MapSourceDeleted { get; }
}

/// <summary>
/// 删除 Provider 时收口 GW 权威文档与同源 MAP 遗留文档。
///
/// MAP 来源只允许内部租户访问；GW 原生文档若与 MAP 碰巧同 id、却没有明确声明
/// SourceCollection=llmplatforms，则判为歧义并拒绝，不根据名称或地址猜关联。
/// </summary>
public static class PlatformDeletionCoordinator
{
    public const string MapSourceCollection = "llmplatforms";

    public static async Task<PlatformDeletionTarget?> ResolveAsync(
        IMongoCollection<BsonDocument> gatewayPlatforms,
        IMongoCollection<BsonDocument> mapPlatforms,
        string tenantId,
        string internalTenantId,
        string platformId,
        CancellationToken ct = default)
    {
        var fb = Builders<BsonDocument>.Filter;
        var gatewayFilter = fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", platformId));
        var gateway = await gatewayPlatforms.Find(gatewayFilter).FirstOrDefaultAsync(ct);
        var mapSource = string.Equals(tenantId, internalTenantId, StringComparison.Ordinal)
            ? await mapPlatforms.Find(fb.Eq("_id", platformId)).FirstOrDefaultAsync(ct)
            : null;

        if (gateway is null && mapSource is null) return null;
        if (gateway is null)
        {
            return new PlatformDeletionTarget(
                platformId,
                mapSource!,
                null,
                mapSource,
                PlatformDeletionScope.MapOnly);
        }

        if (mapSource is null)
        {
            return new PlatformDeletionTarget(
                platformId,
                gateway,
                gateway,
                null,
                PlatformDeletionScope.GatewayOnly);
        }

        var sourceCollection = gateway.TryGetValue("SourceCollection", out var sourceValue)
                               && sourceValue.IsString
            ? sourceValue.AsString.Trim()
            : string.Empty;
        var scope = string.Equals(sourceCollection, MapSourceCollection, StringComparison.Ordinal)
            ? PlatformDeletionScope.GatewayAndMapSource
            : PlatformDeletionScope.Ambiguous;
        return new PlatformDeletionTarget(platformId, gateway, gateway, mapSource, scope);
    }

    public static async Task<PlatformDeletionResult> DeleteAsync(
        IMongoCollection<BsonDocument> gatewayPlatforms,
        IMongoCollection<BsonDocument> mapPlatforms,
        string tenantId,
        PlatformDeletionTarget target,
        CancellationToken ct = default)
    {
        if (target.Scope == PlatformDeletionScope.Ambiguous)
            throw new PlatformDeletionException(
                "不能删除未确认同源关系的双域 Provider",
                "precondition",
                gatewayDeleted: false,
                mapSourceDeleted: false);

        var fb = Builders<BsonDocument>.Filter;
        var mapDeleted = false;
        if (target.MapSourceDocument is not null)
        {
            try
            {
                var result = await mapPlatforms.DeleteOneAsync(fb.Eq("_id", target.PlatformId), ct);
                mapDeleted = result.DeletedCount == 1;
                if (!mapDeleted)
                {
                    // 并发删除已经达到目标状态，按幂等成功处理；仍存在则说明写入状态发生了变化。
                    var stillExists = await mapPlatforms.Find(fb.Eq("_id", target.PlatformId)).AnyAsync(ct);
                    if (stillExists)
                        throw new InvalidOperationException("旧 MAP Provider 在删除期间发生变化，请刷新后重试");
                }
            }
            catch (Exception ex) when (ex is MongoException or InvalidOperationException)
            {
                throw new PlatformDeletionException(
                    ex.Message,
                    "map-source",
                    gatewayDeleted: false,
                    mapSourceDeleted: mapDeleted,
                    ex);
            }
        }

        var gatewayDeleted = false;
        if (target.GatewayDocument is not null)
        {
            try
            {
                var gatewayFilter = fb.And(fb.Eq("TenantId", tenantId), fb.Eq("_id", target.PlatformId));
                var result = await gatewayPlatforms.DeleteOneAsync(gatewayFilter, ct);
                gatewayDeleted = result.DeletedCount == 1;
                if (!gatewayDeleted)
                {
                    var stillExists = await gatewayPlatforms.Find(gatewayFilter).AnyAsync(ct);
                    if (stillExists)
                        throw new InvalidOperationException("Gateway Provider 在删除期间发生变化，请刷新后重试");
                }
            }
            catch (Exception ex) when (ex is MongoException or InvalidOperationException)
            {
                throw new PlatformDeletionException(
                    ex.Message,
                    "gateway",
                    gatewayDeleted,
                    mapDeleted,
                    ex);
            }
        }

        return new PlatformDeletionResult(gatewayDeleted, mapDeleted);
    }
}
