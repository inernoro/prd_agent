using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>平台及同 ID 旧副本的删除计划；MAP 副本只属于内部租户。</summary>
public static class ProviderRemovalPolicy
{
    public static bool MayRemoveMapMirror(string tenantId, string internalTenantId)
        => string.Equals(tenantId, internalTenantId, StringComparison.Ordinal);

    public static bool ShouldDisableMapMirror(string tenantId, string internalTenantId, bool enabled)
        => !enabled && MayRemoveMapMirror(tenantId, internalTenantId);

    public static BsonDocument? SelectSource(BsonDocument? gateway, BsonDocument? mapMirror, bool internalTenant)
        => gateway ?? (internalTenant ? mapMirror : null);

    /// <summary>不按名称或域名删除，只匹配同 ID、读到的时间戳，以及 GW 的租户身份。</summary>
    public static FilterDefinition<BsonDocument> UnchangedFilter(BsonDocument snapshot, string? tenantId = null)
    {
        var fb = Builders<BsonDocument>.Filter;
        var filter = fb.And(fb.Eq("_id", snapshot.GetStringOrEmpty("_id")),
            snapshot.Contains("UpdatedAt") ? fb.Eq("UpdatedAt", snapshot["UpdatedAt"]) : fb.Exists("UpdatedAt", false));
        return tenantId is null ? filter : fb.And(filter, fb.Eq("TenantId", tenantId));
    }
}
