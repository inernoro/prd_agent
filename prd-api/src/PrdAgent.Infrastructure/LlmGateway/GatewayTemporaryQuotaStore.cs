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
