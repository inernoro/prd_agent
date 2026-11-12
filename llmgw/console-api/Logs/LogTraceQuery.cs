using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.Logs;

/// <summary>只按持久化身份关联；请求正文、时间相近、模型相同都不是重复或重试证据。</summary>
public static class LogTraceQuery
{
    private static readonly FilterDefinitionBuilder<BsonDocument> F = Builders<BsonDocument>.Filter;

    public static FilterDefinition<BsonDocument> Reference(string reference) => F.Or(
        new[] { "_id", "RequestId", "RunId", "LogicalRequestId", "ProviderRequestId", "ProviderTaskId" }
            .Select(field => F.Eq(field, reference)));

    public static FilterDefinition<BsonDocument> LegacySummary => F.And(
        F.Eq("Provider", "anthropic-sdk"), F.Eq("RequestType", "agent"),
        F.Eq("Path", "/v1/messages"), F.Eq("GatewayTransport", "http"),
        F.Or(F.Eq("IngressProtocol", BsonNull.Value), F.Eq("IngressProtocol", "")));

    public static string Root(BsonDocument doc)
    {
        foreach (var field in new[] { "RunId", "LogicalRequestId" })
            if (Text(doc, field) is { Length: > 0 } value) return field + ":" + value;
        return "_id:" + Text(doc, "_id");
    }

    public static FilterDefinition<BsonDocument> Related(BsonDocument anchor)
    {
        var filters = new List<FilterDefinition<BsonDocument>> { F.Eq("_id", anchor["_id"]) };
        foreach (var field in new[] { "RunId", "LogicalRequestId" })
            if (Text(anchor, field) is { Length: > 0 } value) filters.Add(F.Eq(field, value));
        // 作业编号只在同一上游线路内有意义，不能跨供应商撞号关联。
        if (Text(anchor, "ProviderTaskId") is { Length: > 0 } task
            && Text(anchor, "PlatformId") is { Length: > 0 } platform)
            filters.Add(F.And(F.Eq("ProviderTaskId", task), F.Eq("PlatformId", platform)));
        return F.Or(filters);
    }

    public static bool IsLegacySummary(BsonDocument doc) =>
        Text(doc, "Provider") == "anthropic-sdk" && Text(doc, "RequestType") == "agent"
        && Text(doc, "Path") == "/v1/messages" && Text(doc, "GatewayTransport") == "http"
        && string.IsNullOrEmpty(Text(doc, "IngressProtocol"));

    public static string? Text(BsonDocument doc, string field) =>
        doc.TryGetValue(field, out var value) && value.IsString ? value.AsString : null;
}
