using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.Infrastructure.LlmGateway;

public sealed record GatewayTemporaryQuotaReservation(string AlertId, string TenantId, string Id);

/// <summary>先占用一个临时额度名额，通过后续治理后再正式扣减。</summary>
public sealed class GatewayTemporaryQuotaStore(IMongoDatabase database, ILogger logger)
{
    public const string AlertsCollection = "llmgw_consumption_alerts";
    private const string Reservations = "QuotaReservations";
    private const int ReservationLifetimeMs = 120_000;
    private IMongoCollection<BsonDocument> Alerts => database.GetCollection<BsonDocument>(AlertsCollection);

    public static bool AppliesTo(string scope, string origin, int seconds)
        => scope == "app-caller" && origin == "automatic" && seconds == 3600;

    public async Task<GatewayTemporaryQuotaReservation?> TryReserveAsync(string alertId, string tenantId, CancellationToken ct)
    {
        var reservation = new GatewayTemporaryQuotaReservation(alertId, tenantId, Guid.NewGuid().ToString("N"));
        var active = new BsonDocument("$filter", new BsonDocument
        {
            { "input", new BsonDocument("$ifNull", new BsonArray { "$" + Reservations, new BsonArray() }) },
            { "cond", new BsonDocument("$gt", new BsonArray { "$$this.ExpiresAt", "$$NOW" }) },
        });
        var capacity = new BsonDocument("$lt", new BsonArray
        {
            new BsonDocument("$add", new BsonArray { "$QuotaUsed", new BsonDocument("$size", active) }), "$QuotaUnits",
        });
        var stage = new BsonDocument("$set", new BsonDocument(Reservations,
            new BsonDocument("$concatArrays", new BsonArray { active, new BsonArray
            {
                new BsonDocument { { "Id", reservation.Id },
                    { "ExpiresAt", new BsonDocument("$add", new BsonArray { "$$NOW", ReservationLifetimeMs }) } },
            } })));
        try
        {
            var result = await Alerts.UpdateOneAsync(AvailableQuota(reservation, capacity),
                new PipelineUpdateDefinition<BsonDocument>(new[] { stage }), cancellationToken: ct);
            return result.ModifiedCount == 1 ? reservation : null;
        }
        catch (MongoException error)
        {
            logger.LogWarning(error, "[GatewaySafety] Temporary quota unavailable for alert {AlertId}", alertId);
            return null;
        }
    }

    public async Task<bool> TryConsumeAsync(GatewayTemporaryQuotaReservation reservation, CancellationToken ct)
    {
        try
        {
            var capacity = new BsonDocument("$lt", new BsonArray { "$QuotaUsed", "$QuotaUnits" });
            var result = await Alerts.UpdateOneAsync(AvailableQuota(reservation, capacity) & OwnedReservation(reservation),
                RemoveReservation(reservation).Inc("QuotaUsed", 1).CurrentDate("ResolutionUpdatedAt"),
                cancellationToken: ct);
            return result.ModifiedCount == 1;
        }
        catch (MongoException error)
        {
            logger.LogWarning(error, "[GatewaySafety] Temporary quota unavailable for alert {AlertId}", reservation.AlertId);
            return false;
        }
    }

    public async Task ReleaseAsync(GatewayTemporaryQuotaReservation reservation)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try
        {
            await Alerts.UpdateOneAsync(OwnedReservation(reservation), RemoveReservation(reservation), cancellationToken: timeout.Token);
        }
        catch (Exception error) when (error is MongoException or OperationCanceledException)
        {
            logger.LogWarning(error, "[GatewaySafety] Temporary quota reservation will expire for alert {AlertId}", reservation.AlertId);
        }
    }

    private static FilterDefinition<BsonDocument> OwnedReservation(GatewayTemporaryQuotaReservation reservation)
        => new BsonDocument { { "_id", reservation.AlertId }, { "TenantId", reservation.TenantId }, { Reservations + ".Id", reservation.Id } };

    private static UpdateDefinition<BsonDocument> RemoveReservation(GatewayTemporaryQuotaReservation reservation)
        => Builders<BsonDocument>.Update.PullFilter<BsonDocument>(Reservations, new BsonDocument("Id", reservation.Id));

    private static FilterDefinition<BsonDocument> AvailableQuota(GatewayTemporaryQuotaReservation reservation, BsonDocument capacity)
    {
        var match = Builders<BsonDocument>.Filter;
        return match.Eq("_id", reservation.AlertId) & match.Eq("TenantId", reservation.TenantId) & match.Eq("QuotaState", "approved")
            & new BsonDocument("$expr", new BsonDocument("$and", new BsonArray
            {
                new BsonDocument("$gt", new BsonArray { "$QuotaExpiresAt", "$$NOW" }),
                capacity,
            }));
    }
}

public sealed record GatewayConsumptionRetryOwner(string TenantId, string KeyId, string Caller);

public sealed record GatewayConsumptionRetryWorkItem(string Id, string RunId, string FirstBlockedRequestId, DateTime ExpiresAt);

/// <summary>临时额度和恢复后补跑共用同一告警；这里只存取补跑批次，调用授权由网关执行。</summary>
public sealed class GatewayConsumptionRetryStore(IMongoDatabase database)
{
    public const string CollectionName = "llmgw_consumption_retries";
    private static readonly FilterDefinitionBuilder<BsonDocument> Where = Builders<BsonDocument>.Filter;
    private static readonly UpdateDefinitionBuilder<BsonDocument> Update = Builders<BsonDocument>.Update;
    private IMongoCollection<BsonDocument> Retries => database.GetCollection<BsonDocument>(CollectionName);

    public async Task RecordAsync(string alertId, GatewayConsumptionRetryOwner owner,
        string runId, string requestId, DateTime readyAt, CancellationToken ct)
    {
        var id = alertId + ":" + owner.KeyId + ":" + runId;
        var update = Update.SetOnInsert("TenantId", owner.TenantId).SetOnInsert("AppCallerCode", owner.Caller)
            .SetOnInsert("AlertId", alertId).SetOnInsert("ServiceKeyId", owner.KeyId).SetOnInsert("RunId", runId)
            .SetOnInsert("State", "available").SetOnInsert("ReadyAt", readyAt)
            .SetOnInsert("ExpiresAt", readyAt.AddDays(7)).SetOnInsert("FirstBlockedRequestId", requestId);
        try
        {
            await Retries.UpdateOneAsync(Where.Eq("_id", id), update, new UpdateOptions { IsUpsert = true }, ct);
        }
        catch (MongoWriteException error) when (error.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            // 并发登记的同一批次继续共用一项补跑动作。
        }
    }

    public async Task<IReadOnlyList<GatewayConsumptionRetryWorkItem>> ReadReadyAsync(GatewayConsumptionRetryOwner owner,
        CancellationToken ct)
    {
        var rows = await Retries.Find(WorkerScope(owner) & Where.Eq("State", "queued") & ReadyAt(DateTime.UtcNow))
            .SortBy(row => row["ReadyAt"]).Limit(25).ToListAsync(ct);
        return rows.Select(row => new GatewayConsumptionRetryWorkItem(row["_id"].AsString, row["RunId"].AsString,
            row["FirstBlockedRequestId"].AsString, row["ExpiresAt"].AsBsonDateTime.ToUniversalTime())).ToArray();
    }

    public async Task<bool> ApplyReceiptAsync(GatewayConsumptionRetryOwner owner, string id, string claimId,
        string outcome, int? count, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var identity = WorkerScope(owner) & Where.Eq("_id", id);
        var ownedClaim = identity & Where.Eq("ClaimId", claimId);
        var ready = ReadyAt(now);
        var claiming = outcome == "claim";
        var completedCount = count is { } value ? (BsonValue)new BsonInt32(value) : BsonNull.Value;
        var transition = claiming
            ? Update.Set("State", "running").Set("ClaimId", claimId).Set("ClaimedAt", now)
            : Update.Set("State", outcome).Set("FinishedAt", now).Set("CompletedCount", completedCount);
        var before = claiming ? identity & Where.Eq("State", "queued") : ownedClaim & Where.Eq("State", "running");
        var applied = claiming ? ownedClaim & ready & Where.Eq("State", "running")
            : ownedClaim & Where.Eq("State", outcome) & Where.Eq("CompletedCount", completedCount);
        var result = await Retries.UpdateOneAsync(before & ready, transition, cancellationToken: ct);
        return result.ModifiedCount == 1 || await Retries.Find(applied).AnyAsync(ct);
    }

    private static FilterDefinition<BsonDocument> ReadyAt(DateTime now)
        => Where.Lte("ReadyAt", now) & Where.Gt("ExpiresAt", now);

    private static FilterDefinition<BsonDocument> WorkerScope(GatewayConsumptionRetryOwner owner)
    {
        // 只对调用方名称忽略大小写，租户、密钥、批次和领取标识仍须精确匹配。兼容已用原大小写存下的批次。
        var caller = Regex.Escape(GatewayAppCallerIdentity.NormalizePart(owner.Caller));
        return Where.Eq("TenantId", owner.TenantId) & Where.Eq("ServiceKeyId", owner.KeyId)
            & Where.Regex("AppCallerCode", new BsonRegularExpression($@"\A{caller}\z", "i"));
    }
}
