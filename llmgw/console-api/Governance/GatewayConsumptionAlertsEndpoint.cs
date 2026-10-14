using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.Governance;

public static class GatewayConsumptionAlertsEndpoint
{
    public static void MapGatewayConsumptionAlerts(this WebApplication app, IMongoDatabase database, JsonSerializerOptions jsonOptions)
    {
        app.MapGet("/gw/logs/consumption-alerts", async (HttpContext http, int? limit) =>
        {
            // 与日志同一租户/团队授权；不能通过 query 切到别的租户或查看其他团队的预警。
            var filter = TenantAccess.FilterTeamScope(http,
                Builders<BsonDocument>.Filter.Eq("Status", "open")
                & Builders<BsonDocument>.Filter.Gte("CreatedAt", DateTime.UtcNow.AddDays(-7)));
            var alerts = database.GetCollection<BsonDocument>("llmgw_consumption_alerts");
            var docs = await alerts.Find(filter)
                .Sort(Builders<BsonDocument>.Sort.Descending("UpdatedAt").Ascending("_id"))
                .Limit(Math.Clamp(limit ?? 10, 1, 100))
                .ToListAsync(http.RequestAborted);
            var items = docs.Select(doc => new
            {
                Id = doc.GetStringOrEmpty("_id"),
                AppCallerCode = doc.GetStringOrEmpty("AppCallerCode"),
                RequestType = doc.GetStringOrEmpty("RequestType"),
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
            }).ToList();
            return Results.Json(ApiEnvelope<object>.Ok(new { Items = items }), jsonOptions);
        }).RequireAuthorization("LogsRead");
    }
}
