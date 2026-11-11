using MongoDB.Bson;
using System.Security.Cryptography;
using System.Text;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.ModelUpgrades;

public static class ModelUpgradeWire
{
    public static string Fingerprint(BsonDocument route)
    {
        var values = new BsonArray { route.GetValue("_id", ""), route.GetValue("LogicalModelId", ""),
            route.GetValue("TargetKind", "model"), route.GetValue("TargetId", ""),
            route.GetValue("UpstreamModelId", BsonNull.Value), route.GetValue("Protocol", BsonNull.Value),
            route.GetValue("EndpointPath", BsonNull.Value), route.GetValue("Enabled", false) };
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(values.ToJson()))).ToLowerInvariant();
    }
    public static ModelUpgradeRouteSnapshot Capture(BsonDocument route, BsonDocument model, BsonDocument provider)
    {
        var updated = route.AsNullableUtcDateTime("UpdatedAt");
        var upstream = route.AsNullableString("UpstreamModelId");
        if (string.IsNullOrWhiteSpace(upstream)) upstream = model.GetStringOrEmpty("ModelName");
        if (route.GetValue("Enabled", false) != true || route.Contains("SupersededByOfferingId")
            || (route.AsNullableString("TargetKind") ?? "model") != "model" || route.GetStringOrEmpty("TargetId") != model.GetStringOrEmpty("_id")
            || upstream != model.GetStringOrEmpty("ModelName"))
            throw new ModelUpgradeException("CANDIDATE_WIRE_REQUIRED", "候选线路身份或版本不完整，请修复固定型号线路后重新验收。");
        var protocol = route.AsNullableString("Protocol");
        if (string.IsNullOrWhiteSpace(protocol)) protocol = model.AsNullableString("Protocol");
        if (string.IsNullOrWhiteSpace(protocol)) protocol = provider.AsNullableString("PlatformType");
        if (string.IsNullOrWhiteSpace(protocol)) throw new ModelUpgradeException("CANDIDATE_WIRE_REQUIRED", "候选线路缺少有效协议，请先修复线路再验收。");
        return new() { OfferingId = route.GetStringOrEmpty("_id"), LogicalModelId = route.GetStringOrEmpty("LogicalModelId"),
            ModelId = model.GetStringOrEmpty("_id"), UpstreamModelId = upstream, OfferingVersion = Fingerprint(route), OfferingUpdatedAt = updated,
            Protocol = protocol, EndpointPath = route.AsNullableString("EndpointPath") };
    }
    public static bool Matches(ModelUpgradeRouteSnapshot snapshot, BsonDocument route, BsonDocument model, BsonDocument provider)
    {
        try
        {
            var current = Capture(route, model, provider);
            return snapshot.OfferingId == current.OfferingId && snapshot.LogicalModelId == current.LogicalModelId
                && snapshot.ModelId == current.ModelId && snapshot.UpstreamModelId == current.UpstreamModelId
                && snapshot.Protocol == current.Protocol && snapshot.EndpointPath == current.EndpointPath
                && snapshot.OfferingVersion == current.OfferingVersion;
        }
        catch (ModelUpgradeException) { return false; }
    }
    public static bool LogMatches(ModelUpgradeRouteSnapshot snapshot, BsonDocument log)
    {
        var path = log.AsNullableString("Path");
        if (log.AsNullableString("OfferingId") != snapshot.OfferingId || string.IsNullOrWhiteSpace(path)
            || !string.Equals(log.AsNullableString("Protocol"), snapshot.Protocol, StringComparison.OrdinalIgnoreCase)) return false;
        if (string.IsNullOrWhiteSpace(snapshot.EndpointPath)) return true;
        var expected = snapshot.EndpointPath.Trim('/');
        var actual = Uri.TryCreate(path, UriKind.Absolute, out var uri) ? uri.AbsolutePath.Trim('/') : path.Trim('/');
        return actual == expected || actual.EndsWith("/" + expected, StringComparison.Ordinal);
    }
    public static void Apply(BsonDocument replacement, ModelUpgradeRouteSnapshot snapshot)
    {
        replacement["Protocol"] = snapshot.Protocol;
        if (snapshot.EndpointPath is null) replacement.Remove("EndpointPath");
        else replacement["EndpointPath"] = snapshot.EndpointPath;
    }
}
