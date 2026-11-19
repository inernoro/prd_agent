using System.Text.Json;
using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.LogicalModels;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.Governance;

public static class GatewayConsumptionAlertsEndpoint
{
    private static readonly FilterDefinitionBuilder<BsonDocument> Where = Builders<BsonDocument>.Filter;
    private static readonly UpdateDefinitionBuilder<BsonDocument> Update = Builders<BsonDocument>.Update;
    private static readonly IEqualityComparer<(string Code, string RequestType)> CallerIdentityComparer =
        EqualityComparer<(string Code, string RequestType)>.Create(
            (left, right) => AppCallerIdentityPolicy.Comparer.Equals(left.Code, right.Code)
                && AppCallerIdentityPolicy.Comparer.Equals(left.RequestType, right.RequestType),
            identity => HashCode.Combine(AppCallerIdentityPolicy.Comparer.GetHashCode(identity.Code),
                AppCallerIdentityPolicy.Comparer.GetHashCode(identity.RequestType)));

    public static void MapGatewayConsumptionAlerts(this WebApplication app, IMongoDatabase database, JsonSerializerOptions jsonOptions)
    {
        var alerts = database.GetCollection<BsonDocument>("llmgw_consumption_alerts");
        var retries = database.GetCollection<BsonDocument>("llmgw_consumption_retries");
        var group = app.MapGroup("/gw/logs/consumption-alerts").RequireAuthorization("LogsRead");
        group.MapGet("", async (HttpContext http, int? limit) =>
        {
            var now = DateTime.UtcNow;
            var access = TenantAccess.GetRequired(http);
            var docs = await alerts.Find(RecentVisibleAlerts(http, now))
                .Sort(Builders<BsonDocument>.Sort.Descending("UpdatedAt").Ascending("_id"))
                .Limit(Math.Clamp(limit ?? 10, 1, 100))
                .ToListAsync(http.RequestAborted);
            var retryCounts = await ReadRetryCountsAsync(retries, access.TenantId,
                docs.Where(CanResolve).Select(doc => doc["_id"].AsString).ToArray(), now, http.RequestAborted);
            var callers = await ReadCallersAsync(database, http, docs);
            var canRequest = LlmGwPermissions.Allows(access.Role, LlmGwPermissions.AppCallerWrite);
            var canApprove = LlmGwPermissions.Allows(access.Role, LlmGwPermissions.ConfigWrite);
            var items = docs.Select(doc => new
            {
                Id = doc.GetStringOrEmpty("_id"),
                Metric = doc.GetStringOrEmpty("Metric"),
                BaselineAverage = doc.AsNullableDecimal("BaselineAverage"),
                BaselineSamples = doc.AsNullableInt("BaselineSamples"),
                AppCallerCode = doc.GetStringOrEmpty("AppCallerCode"),
                RequestType = doc.GetStringOrEmpty("RequestType"),
                AppCallerTitle = callers.GetValueOrDefault(CallerIdentity(doc))?.AsNullableString("Title"),
                Owner = callers.GetValueOrDefault(CallerIdentity(doc))?.AsNullableString("Owner"),
                Scope = doc.GetStringOrEmpty("Scope"),
                Origin = doc.GetStringOrEmpty("Origin"),
                SourceDeployment = doc.AsNullableString("SourceDeployment"),
                WindowStart = doc.AsNullableUtcDateTime("WindowStart"),
                WindowSeconds = doc.AsNullableInt("WindowSeconds") ?? 0,
                Count = doc.AsNullableLong("Count") ?? 0,
                Limit = doc.AsNullableInt("Limit") ?? 0,
                Kind = doc.GetStringOrEmpty("Kind"),
                CreatedAt = doc.AsNullableUtcDateTime("CreatedAt"),
                UpdatedAt = doc.AsNullableUtcDateTime("UpdatedAt"),
                RestoresAt = GetRestoreTime(doc),
                CanRequestResolution = canRequest && CanResolve(doc),
                CanDecideQuota = canApprove && CanResolve(doc),
                Retry = retryCounts.GetValueOrDefault(doc.GetStringOrEmpty("_id")),
                Quota = ReadQuota(doc, now),
            }).ToList();
            return Results.Json(ApiEnvelope<object>.Ok(new { Items = items }), jsonOptions);
        });

        group.MapPost("/{id}/resolution", async (HttpContext http, string id, ConsumptionAlertResolutionInput input) =>
        {
            var access = TenantAccess.GetRequired(http);
            var canDecide = LlmGwPermissions.Allows(access.Role, LlmGwPermissions.ConfigWrite);
            if (!LlmGwPermissions.Allows(access.Role, LlmGwPermissions.AppCallerWrite)
                || ((input.Action is "approve-quota" or "deny-quota") && !canDecide))
                return Error("RESOLUTION_FORBIDDEN", "当前账号无法执行此处理，请联系调用方负责人或网关管理员。", 403);

            var now = DateTime.UtcNow;
            var scope = RecentVisibleAlerts(http, now) & Where.Eq("_id", id);
            var ct = http.RequestAborted;
            var alert = await alerts.Find(scope).FirstOrDefaultAsync(ct);
            if (alert is null) return Error("ALERT_NOT_FOUND", "此预警已不可见，请刷新请求记录。", 404);
            if (!CanResolve(alert) || GetRestoreTime(alert) is not { } restoresAt)
                return Error("ALERT_ACTION_UNAVAILABLE", "此预警的处置入口不可用，请在请求记录核对调用方。", 409);

            switch (input.Action)
            {
                case "retry":
                    var target = Where.Eq("TenantId", access.TenantId) & Where.Eq("AlertId", id);
                    var queued = await retries.UpdateManyAsync(target & Where.Eq("State", "available") & Where.Gt("ExpiresAt", now),
                        Update.Set("State", "queued").Set("QueuedAt", now).Set("QueuedBy", access.UserId), cancellationToken: ct);
                    if (queued.ModifiedCount > 0 || await retries.Find(target & Where.Ne("State", "available")).AnyAsync(ct))
                        return Success();
                    return Error("ALERT_RETRY_NOT_LINKED", "此预警没有可关联的补跑批次，请从原业务入口处理未完成项。", 409);

                case "request-quota":
                    var reason = input.Reason?.Trim();
                    if (input.Units is not > 0 || input.Units > (alert.AsNullableInt("Limit") ?? 0)
                        || reason is not { Length: > 0 and <= 300 })
                        return Error("QUOTA_INPUT_INVALID", "请输入不超过原限额的额外次数，并填写 300 字以内的申请理由。", 400);
                    if (restoresAt <= now)
                        return Error("QUOTA_WINDOW_ENDED", "这个限流窗口已结束，额度已恢复，请核对当前批次。", 409);
                    var requested = await alerts.UpdateOneAsync(scope & Where.Exists("QuotaState", false)
                            & TimeStillBefore(new BsonDocument("$add", new BsonArray { "$WindowStart", 3600000 })),
                        Update.Set("QuotaState", "pending").Set("QuotaUnits", input.Units.Value)
                            .Set("QuotaUsed", 0).Set("QuotaReason", reason).Set("QuotaExpiresAt", restoresAt)
                            .Set("QuotaRequestedBy", access.UserId).Set("QuotaRequestedAt", now),
                        cancellationToken: ct);
                    if (requested.ModifiedCount == 1) return Success();
                    return Error("QUOTA_REQUEST_CHANGED", "此预警已有额度处理记录，或窗口已到期，请刷新查看。", 409);

                case "approve-quota":
                case "deny-quota":
                    var decision = input.Action == "approve-quota" ? "approved" : "denied";
                    var reviewed = await alerts.UpdateOneAsync(scope & Where.Eq("QuotaState", "pending")
                            & TimeStillBefore("$QuotaExpiresAt"),
                        Update.Set("QuotaState", decision).Set("QuotaReviewedAt", now).Set("QuotaReviewedBy", access.UserId),
                        cancellationToken: ct);
                    if (reviewed.ModifiedCount == 1) return Success();
                    return Error("QUOTA_REQUEST_CHANGED", "这条申请已处理或到期，请刷新查看最新结果。", 409);

                default:
                    return Error("ALERT_ACTION_UNKNOWN", "此操作不可用，请刷新预警后选择处理方式。", 400);
            }
        });

        IResult Success() => Results.Json(ApiEnvelope<object>.Ok(new { Updated = true }), jsonOptions);
        IResult Error(string code, string message, int status) =>
            Results.Json(ApiEnvelope<object>.Fail(code, message), jsonOptions, statusCode: status);
    }

    private static FilterDefinition<BsonDocument> RecentVisibleAlerts(HttpContext http, DateTime now) =>
        TenantAccess.FilterTeamScope(http, Where.Eq("Status", "open") & Where.Gte("CreatedAt", now.AddDays(-7)));

    private static bool CanResolve(BsonDocument doc) =>
        doc.GetStringOrEmpty("Kind") == "blocked" && doc.GetStringOrEmpty("Metric") is ("" or "requests")
        && doc.GetStringOrEmpty("Scope") == "app-caller" && doc.GetStringOrEmpty("Origin") == "automatic"
        && doc.AsNullableInt("WindowSeconds") == 3600;

    private static DateTime? GetRestoreTime(BsonDocument doc) =>
        doc.GetStringOrEmpty("Kind") == "blocked" && doc.GetStringOrEmpty("Metric") is ("" or "requests")
        && doc.AsNullableInt("WindowSeconds") is (60 or 3600 or 86400)
            ? doc.AsNullableUtcDateTime("WindowStart")?.AddSeconds(doc.AsNullableInt("WindowSeconds")!.Value)
            : null;

    private static FilterDefinition<BsonDocument> TimeStillBefore(BsonValue deadline) =>
        new BsonDocument("$expr", new BsonDocument("$lt", new BsonArray { "$$NOW", deadline }));

    private static (string Code, string RequestType) CallerIdentity(BsonDocument doc) =>
        (doc.GetStringOrEmpty("AppCallerCode"), doc.GetStringOrEmpty("RequestType"));

    private static async Task<Dictionary<(string, string), BsonDocument>> ReadCallersAsync(
        IMongoDatabase database, HttpContext http, IEnumerable<BsonDocument> alerts)
    {
        var identities = alerts.Where(doc => doc.GetStringOrEmpty("Scope") == "app-caller")
            .Select(CallerIdentity).Distinct(CallerIdentityComparer).ToArray();
        if (identities.Length == 0) return new(CallerIdentityComparer);
        // 只对调用方身份忽略大小写，租户、团队和用户的访问范围仍精确匹配。
        var filter = TenantAccess.FilterTeamScope(http, Where.Or(identities.Select(identity =>
            Where.Regex("AppCallerCode", MatchCallerIdentityPart(identity.Code))
            & Where.Regex("RequestType", MatchCallerIdentityPart(identity.RequestType)))));
        var documents = await database.GetCollection<BsonDocument>("llmgw_app_callers").Find(filter)
            .Project(Builders<BsonDocument>.Projection.Include("AppCallerCode").Include("RequestType").Include("Title").Include("Owner"))
            .ToListAsync(http.RequestAborted);
        return documents.GroupBy(CallerIdentity, CallerIdentityComparer)
            .ToDictionary(group => group.Key, group => group.First(), CallerIdentityComparer);
    }

    private static BsonRegularExpression MatchCallerIdentityPart(string value) => new($@"\A{Regex.Escape(value)}\z", "i");

    private static object? ReadQuota(BsonDocument doc, DateTime now)
    {
        if (doc.AsNullableString("QuotaState") is not { } state || doc.AsNullableUtcDateTime("QuotaExpiresAt") is not { } end)
            return null;
        return new
        {
            State = end <= now && state == "pending" ? "expired" : state,
            Units = doc.AsNullableInt("QuotaUnits") ?? 0,
            Used = doc.AsNullableInt("QuotaUsed") ?? 0,
            Reason = doc.AsNullableString("QuotaReason"),
            ExpiresAt = end,
            ReviewedAt = doc.AsNullableUtcDateTime("QuotaReviewedAt"),
        };
    }

    private static async Task<Dictionary<string, RetryCounts>> ReadRetryCountsAsync(IMongoCollection<BsonDocument> retries,
        string tenantId, string[] alertIds, DateTime now, CancellationToken ct)
    {
        if (alertIds.Length == 0) return new();
        var unfinished = new BsonDocument("$in", new BsonArray { "$State", new BsonArray { "available", "queued", "running" } });
        var pastDeadline = new BsonDocument("$lte", new BsonArray { "$ExpiresAt", new BsonDateTime(now) });
        var state = new BsonDocument("$cond", new BsonArray
        {
            new BsonDocument("$and", new BsonArray { unfinished, pastDeadline }), "expired", "$State",
        });
        var rows = await retries.Aggregate().Match(Where.Eq("TenantId", tenantId) & Where.In("AlertId", alertIds))
            .Group(new BsonDocument
            {
                { "_id", new BsonDocument { { "alert", "$AlertId" }, { "state", state } } },
                { "Batches", new BsonDocument("$sum", 1) },
                { "CompletedCount", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray
                    { new BsonDocument("$eq", new BsonArray { "$State", "completed" }), "$CompletedCount", 0 })) },
            }).ToListAsync(ct);
        return rows.GroupBy(row => row["_id"]["alert"].AsString).ToDictionary(group => group.Key, group =>
        {
            var byState = group.ToDictionary(row => row["_id"]["state"].AsString, row => row["Batches"].ToInt32());
            return new RetryCounts(byState.GetValueOrDefault("available"), byState.GetValueOrDefault("queued"),
                byState.GetValueOrDefault("running"), byState.GetValueOrDefault("completed"),
                byState.GetValueOrDefault("failed"), byState.GetValueOrDefault("expired"),
                group.Sum(row => row["CompletedCount"].ToInt64()));
        });
    }

    internal sealed record ConsumptionAlertResolutionInput(string? Action, int? Units, string? Reason);
    private sealed record RetryCounts(int Available, int Queued, int Running, int Completed, int Failed, int Expired, long CompletedCount);
}
