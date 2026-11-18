using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.LlmGatewayHost;

internal static class GatewayConsumptionRetries
{
    internal const string Path = "/gw/v1/consumption-retries";
    internal const string ControlScope = "retry:control";
    internal const string CollectionName = "llmgw_consumption_retries";
    internal const string OptInHeader = "X-Gateway-Retry-Run-Id";

    internal static string? ReadRunId(HttpContext http, GatewayKeyAuthorization authorization, string? protocol)
    {
        if (!IsScopedKey(authorization) || protocol != "openai-compatible") return null;
        if (!http.Request.Headers.TryGetValue(OptInHeader, out var values) || values.Count != 1) return null;
        var runId = values[0];
        return runId is { Length: > 0 and <= 160 }
            && runId.All(value => char.IsAsciiLetterOrDigit(value) || value is '-' or '_' or '.' or ':')
            ? runId : null;
    }

    internal static async Task RecordAsync(IMongoDatabase database, string alertId, string tenantId, string caller,
        string keyId, string runId, string requestId, DateTime readyAt, CancellationToken ct)
    {
        var retries = database.GetCollection<BsonDocument>(CollectionName);
        var id = alertId + ":" + keyId + ":" + runId;
        var identity = Builders<BsonDocument>.Filter.Eq("_id", id);
        var update = Builders<BsonDocument>.Update
            .SetOnInsert("TenantId", tenantId).SetOnInsert("AppCallerCode", caller)
            .SetOnInsert("AlertId", alertId).SetOnInsert("ServiceKeyId", keyId).SetOnInsert("RunId", runId)
            .SetOnInsert("State", "available").SetOnInsert("ReadyAt", readyAt)
            .SetOnInsert("ExpiresAt", readyAt.AddDays(7)).SetOnInsert("FirstBlockedRequestId", requestId);
        try
        {
            await retries.UpdateOneAsync(identity, update, new UpdateOptions { IsUpsert = true }, ct);
        }
        catch (MongoWriteException error) when (error.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            // 并发的同一批次已经登记，补跑动作仍只有一条。
        }
    }

    internal static void MapGatewayConsumptionRetries(this WebApplication app)
    {
        app.MapGet(Path, async (HttpContext http) =>
        {
            if (GetWorkerScope(http) is not { } scope) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var now = DateTime.UtcNow;
            var filter = Builders<BsonDocument>.Filter;
            var rows = await GetCollection(http).Find(scope & filter.Eq("State", "queued")
                    & filter.Lte("ReadyAt", now) & filter.Gt("ExpiresAt", now))
                .SortBy(row => row["ReadyAt"]).Limit(25).ToListAsync(http.RequestAborted);
            return Results.Ok(new { items = rows.Select(row => new
            {
                id = row["_id"].AsString,
                runId = row["RunId"].AsString,
                firstBlockedRequestId = row["FirstBlockedRequestId"].AsString,
                expiresAt = row["ExpiresAt"].AsBsonDateTime.ToUniversalTime(),
            }) });
        });

        app.MapPost(Path, async (HttpContext http, GatewayConsumptionRetryReceipt body) =>
        {
            if (GetWorkerScope(http) is not { } scope) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (body.Id is not { Length: > 0 and <= 512 } || !Guid.TryParseExact(body.ClaimId, "N", out _)
                || body.Outcome is not ("claim" or "completed" or "failed")
                || body.CompletedCount < 0 || (body.Outcome == "completed" && body.CompletedCount is null))
                return Results.BadRequest(new { error = new { code = "RETRY_RECEIPT_INVALID", message = "补跑回执不完整，请核对实际结果后再提交。" } });

            var retries = GetCollection(http);
            var now = DateTime.UtcNow;
            var filter = Builders<BsonDocument>.Filter;
            var update = Builders<BsonDocument>.Update;
            var identity = scope & filter.Eq("_id", body.Id);
            var owned = identity & filter.Eq("ClaimId", body.ClaimId);
            var ready = filter.Lte("ReadyAt", now) & filter.Gt("ExpiresAt", now);
            var claiming = body.Outcome == "claim";
            var completedCount = body.CompletedCount is { } count ? (BsonValue)new BsonInt32(count) : BsonNull.Value;
            var transition = claiming
                ? update.Set("State", "running").Set("ClaimId", body.ClaimId).Set("ClaimedAt", now)
                : update.Set("State", body.Outcome).Set("FinishedAt", now).Set("CompletedCount", completedCount);
            var before = claiming ? identity & filter.Eq("State", "queued") : owned & filter.Eq("State", "running");
            var applied = claiming ? owned & ready & filter.Eq("State", "running")
                : owned & filter.Eq("State", body.Outcome) & filter.Eq("CompletedCount", completedCount);
            var result = await retries.UpdateOneAsync(before & ready, transition, cancellationToken: http.RequestAborted);
            if (result.ModifiedCount == 1 || await retries.Find(applied).AnyAsync(http.RequestAborted))
                return Results.Ok();
            return Results.NotFound(new { error = new { code = "RETRY_NOT_PENDING", message = "补跑任务已过期或已有其他处理结果，请重新读取任务列表。" } });
        });
    }

    private static FilterDefinition<BsonDocument>? GetWorkerScope(HttpContext http)
    {
        var authorization = http.Items["llmgw.key.authorization"] as GatewayKeyAuthorization;
        if (authorization is null || !IsScopedKey(authorization)
            || authorization.ResolvedAppCallerCode is not { Length: > 0 } caller)
            return null;

        var where = Builders<BsonDocument>.Filter;
        return where.Eq("TenantId", authorization.TenantId) & where.Eq("ServiceKeyId", authorization.KeyId)
            & where.Eq("AppCallerCode", caller);
    }

    private static bool IsScopedKey(GatewayKeyAuthorization authorization) =>
        authorization is { Allowed: true, Authenticated: true, LegacySharedKey: false, RuntimeGrant: null, KeyId.Length: > 0, TenantId.Length: > 0 };

    private static IMongoCollection<BsonDocument> GetCollection(HttpContext http) =>
        http.RequestServices.GetRequiredService<LlmGatewayDataContext>().Database.GetCollection<BsonDocument>(CollectionName);
}

internal sealed record GatewayConsumptionRetryReceipt(string? Id, string? ClaimId, string? Outcome, int? CompletedCount);
