using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.Costs;

public sealed record CostImportScopeLease(
    string TenantId,
    string Provider,
    string? TeamId,
    string Token);

public static class CostImportScopeLock
{
    public static async Task<CostImportScopeLease?> TryAcquireAsync(
        IMongoCollection<BsonDocument> locks,
        string tenantId,
        string provider,
        string? teamId,
        CancellationToken ct)
    {
        var normalizedTeamId = string.IsNullOrWhiteSpace(teamId) ? null : teamId.Trim();
        BsonValue teamValue = normalizedTeamId is null ? BsonNull.Value : new BsonString(normalizedTeamId);
        var now = DateTime.UtcNow;
        var token = Guid.NewGuid().ToString("N");
        var identity = BuildIdentity(tenantId, provider, normalizedTeamId);
        var filter = Builders<BsonDocument>.Filter.And(
            identity,
            Builders<BsonDocument>.Filter.Or(
                Builders<BsonDocument>.Filter.Exists("Token", false),
                Builders<BsonDocument>.Filter.Eq("Token", BsonNull.Value),
                Builders<BsonDocument>.Filter.Lte("ExpiresAt", now)));
        var update = Builders<BsonDocument>.Update
            .SetOnInsert("_id", Guid.NewGuid().ToString("N"))
            .SetOnInsert("TenantId", tenantId)
            .SetOnInsert("Provider", provider)
            .SetOnInsert("TeamId", teamValue)
            .Set("Token", token)
            .Set("ExpiresAt", now.AddSeconds(30));
        try
        {
            var result = await locks.UpdateOneAsync(
                filter,
                update,
                new UpdateOptions { IsUpsert = true },
                ct);
            return result.ModifiedCount == 1 || result.UpsertedId is not null
                ? new CostImportScopeLease(tenantId, provider, normalizedTeamId, token)
                : null;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return null;
        }
        catch (MongoCommandException ex) when (ex.Code is 11000 or 11001)
        {
            return null;
        }
    }

    public static Task ReleaseAsync(
        IMongoCollection<BsonDocument> locks,
        CostImportScopeLease lease,
        CancellationToken ct)
        => locks.DeleteOneAsync(
            Builders<BsonDocument>.Filter.And(
                BuildIdentity(lease.TenantId, lease.Provider, lease.TeamId),
                Builders<BsonDocument>.Filter.Eq("Token", lease.Token)),
            ct);

    public static async Task<bool> TryRenewAsync(
        IMongoCollection<BsonDocument> locks,
        CostImportScopeLease lease,
        CancellationToken ct)
    {
        var filter = Builders<BsonDocument>.Filter.And(
            BuildIdentity(lease.TenantId, lease.Provider, lease.TeamId),
            Builders<BsonDocument>.Filter.Eq("Token", lease.Token));
        var result = await locks.UpdateOneAsync(
            filter,
            Builders<BsonDocument>.Update.Set("ExpiresAt", DateTime.UtcNow.AddSeconds(30)),
            cancellationToken: ct);
        return result.MatchedCount == 1;
    }

    public static FilterDefinition<BsonDocument> BuildIdentity(
        string tenantId,
        string provider,
        string? teamId)
    {
        BsonValue teamValue = string.IsNullOrWhiteSpace(teamId) ? BsonNull.Value : new BsonString(teamId);
        return Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
            Builders<BsonDocument>.Filter.Eq("Provider", provider),
            Builders<BsonDocument>.Filter.Eq("TeamId", teamValue));
    }
}
