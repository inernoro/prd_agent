using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>后台调用方小时限流使用的临时额度。最终扣减时重新验证审批、有效期和剩余次数。</summary>
public sealed class GatewayTemporaryQuotaStore(IMongoDatabase database, ILogger logger)
{
    public const string AlertsCollection = "llmgw_consumption_alerts";

    public static bool AppliesTo(string scope, string origin, int seconds)
        => scope == "app-caller" && origin == "automatic" && seconds == 3600;

    public async Task<bool> IsAvailableAsync(string alertId, string tenantId, CancellationToken ct)
    {
        try
        {
            return await database.GetCollection<BsonDocument>(AlertsCollection)
                .Find(AvailableQuota(alertId, tenantId)).AnyAsync(ct);
        }
        catch (MongoException error)
        {
            logger.LogWarning(error, "[GatewaySafety] Temporary quota unavailable for alert {AlertId}", alertId);
            return false;
        }
    }

    public async Task<bool> TryConsumeAsync(string alertId, string tenantId, CancellationToken ct)
    {
        try
        {
            var result = await database.GetCollection<BsonDocument>(AlertsCollection).UpdateOneAsync(
                AvailableQuota(alertId, tenantId),
                Builders<BsonDocument>.Update.Inc("QuotaUsed", 1).Set("ResolutionUpdatedAt", DateTime.UtcNow),
                cancellationToken: ct);
            return result.ModifiedCount == 1;
        }
        catch (MongoException error)
        {
            logger.LogWarning(error, "[GatewaySafety] Temporary quota unavailable for alert {AlertId}", alertId);
            return false;
        }
    }

    private static FilterDefinition<BsonDocument> AvailableQuota(string alertId, string tenantId)
    {
        var match = Builders<BsonDocument>.Filter;
        return match.Eq("_id", alertId) & match.Eq("TenantId", tenantId) & match.Eq("QuotaState", "approved")
            & new BsonDocument("$expr", new BsonDocument("$and", new BsonArray
            {
                new BsonDocument("$gt", new BsonArray { "$QuotaExpiresAt", "$$NOW" }),
                new BsonDocument("$lt", new BsonArray { "$QuotaUsed", "$QuotaUnits" }),
            }));
    }
}
