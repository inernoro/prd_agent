using System.Text.Json;
using System.Text.Json.Nodes;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.LlmGatewayHost;

/// <summary>
/// OpenAI 标准的模型清单：<c>GET /v1/models</c>。
///
/// 在这之前对外是别扭的：POST 那四条兼容入口（chat/completions、responses、
/// images/generations、messages）都有，唯独没有「列一下有哪些模型」。于是对方能调，
/// 却列不出可调什么——只能我们口头把模型名告诉他，抄错一个字就是 404。
///
/// 三条口径：
///   1. 回的是**这把 key 能用的**白名单，不是全部。租户、团队、appCaller 都从已验证的
///      授权上下文取，绝不读请求自报的字段。
///   2. 价格按线路逐条给，不折算成一个统一价：同一个模型走官网和走中转单价不同，
///      取平均或取最低都会让对方算出来的账和实际对不上。
///   3. 缺价照常发布，pricing 写 null。为了对不上一个价就让模型不可用，代价比那笔账大。
/// </summary>
public static class GatewayModelCatalogEndpoint
{
    /// <summary>OpenAI 的 model 对象要求 created 是秒级时间戳。</summary>
    private static long ToUnixSeconds(DateTime value)
        => new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc)).ToUnixTimeSeconds();

    public static async Task<JsonObject> BuildAsync(
        LlmGatewayDataContext data,
        string tenantId,
        string? appCallerCode,
        CancellationToken ct)
    {
        var db = data.Context.Database;
        var logicalModels = db.GetCollection<GatewayLogicalModel>("llmgw_logical_models");
        var offerings = db.GetCollection<GatewayModelOffering>("llmgw_model_offerings");
        var physicalModels = db.GetCollection<BsonDocument>("llmgw_models");

        var lf = Builders<GatewayLogicalModel>.Filter;
        var logicals = await logicalModels
            .Find(lf.And(lf.Eq(x => x.TenantId, tenantId), lf.Eq(x => x.Enabled, true)))
            .ToListAsync(ct);

        // 授权范围为空 = 当前租户全部 appCaller 可用；非空就必须点名命中这把 key 的 appCaller。
        // 请求没带 appCaller 时只回不限授权的那部分——宁可少列，不可把受限模型透给不该看的人。
        var visible = logicals
            .Where(x => x.AllowedAppCallerCodes.Count == 0
                || (appCallerCode is { Length: > 0 }
                    && x.AllowedAppCallerCodes.Contains(appCallerCode, StringComparer.OrdinalIgnoreCase)))
            .OrderBy(x => x.DisplayOrder)
            .ThenBy(x => x.PublicId, StringComparer.Ordinal)
            .ToList();
        if (visible.Count == 0)
            return new JsonObject { ["object"] = "list", ["data"] = new JsonArray() };

        var logicalIds = visible.Select(x => x.Id).ToList();
        var of = Builders<GatewayModelOffering>.Filter;
        var routes = await offerings
            .Find(of.And(
                of.Eq(x => x.TenantId, tenantId),
                of.In(x => x.LogicalModelId, logicalIds),
                of.Eq(x => x.Enabled, true)))
            .ToListAsync(ct);
        var routesByLogical = routes
            .GroupBy(x => x.LogicalModelId, StringComparer.Ordinal)
            .ToDictionary(x => x.Key, x => x.OrderBy(r => r.Priority).ToList(), StringComparer.Ordinal);

        var targetIds = routes.Where(x => x.TargetKind == "model").Select(x => x.TargetId).Distinct(StringComparer.Ordinal).ToList();
        var priceByModelId = targetIds.Count == 0
            ? new Dictionary<string, BsonDocument>(StringComparer.Ordinal)
            : (await physicalModels
                .Find(Builders<BsonDocument>.Filter.And(
                    Builders<BsonDocument>.Filter.Eq("TenantId", tenantId),
                    Builders<BsonDocument>.Filter.In("_id", targetIds)))
                .ToListAsync(ct))
                .ToDictionary(x => x.GetValue("_id", BsonNull.Value).AsString, x => x, StringComparer.Ordinal);

        var data_ = new JsonArray();
        foreach (var logical in visible)
        {
            if (!routesByLogical.TryGetValue(logical.Id, out var logicalRoutes) || logicalRoutes.Count == 0)
                continue; // 没有可用线路的模型不承接请求，列出来就是让对方白调一次

            var entry = new JsonObject
            {
                ["id"] = logical.PublicId,
                ["object"] = "model",
                ["created"] = ToUnixSeconds(logical.CreatedAt),
                ["owned_by"] = "llm-gateway",
            };

            var pricedRoutes = new JsonArray();
            foreach (var route in logicalRoutes)
            {
                if (route.TargetKind != "model" || !priceByModelId.TryGetValue(route.TargetId, out var model)) continue;
                var currency = model.GetValue("PriceCurrency", BsonNull.Value);
                // 非美金的价不当美金报：对方拿去算账会差一个数量级，宁可这条线路不报价。
                if (currency.IsString && !string.Equals(currency.AsString, "USD", StringComparison.OrdinalIgnoreCase)) continue;

                var prompt = ReadDecimal(model, "InputPricePerMillion");
                var completion = ReadDecimal(model, "OutputPricePerMillion");
                var cached = ReadDecimal(model, "CachedInputPricePerMillion");
                var perCall = ReadDecimal(model, "PricePerCall");
                if (prompt is null && completion is null && perCall is null) continue;

                var routeNode = new JsonObject
                {
                    ["via"] = route.UpstreamModelId ?? route.TargetId,
                    ["unit"] = perCall is not null ? "per_call" : "per_million_tokens",
                };
                if (perCall is not null) routeNode["call"] = perCall.Value.ToString("0.####");
                if (prompt is not null) routeNode["prompt"] = prompt.Value.ToString("0.####");
                if (completion is not null) routeNode["completion"] = completion.Value.ToString("0.####");
                if (cached is not null) routeNode["cached_prompt"] = cached.Value.ToString("0.####");
                var source = model.GetValue("PriceSource", BsonNull.Value);
                if (source.IsString) routeNode["source"] = source.AsString;
                var observedAt = model.GetValue("PriceObservedAt", BsonNull.Value);
                if (observedAt.IsValidDateTime) routeNode["observed_at"] = observedAt.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ");
                pricedRoutes.Add(routeNode);
            }

            // 扩展字段，OpenAI SDK 遇到不认识的键直接忽略，兼容性不受影响。
            // 一条线路都算不出价时写 null 而不是省略：省略读起来像「免费」，null 是「算不出」。
            entry["pricing"] = pricedRoutes.Count == 0
                ? null
                : new JsonObject { ["currency"] = "USD", ["routes"] = pricedRoutes };
            entry["capabilities"] = new JsonArray(logical.Capabilities.Select(x => (JsonNode)x!).ToArray());
            entry["model_type"] = logical.ModelType;

            data_.Add(entry);
        }

        return new JsonObject { ["object"] = "list", ["data"] = data_ };
    }

    private static decimal? ReadDecimal(BsonDocument doc, string field)
    {
        if (!doc.TryGetValue(field, out var value) || value.IsBsonNull) return null;
        try { return value.ToDecimal(); }
        catch { return null; }
    }

    public static JsonObject BuildNotFound(string modelId) => new()
    {
        ["error"] = new JsonObject
        {
            ["message"] = $"模型 {modelId} 不在这把密钥可用的白名单里",
            ["type"] = "invalid_request_error",
            ["param"] = "model",
            ["code"] = "model_not_found",
        },
    };

    public static string Serialize(JsonNode node, JsonSerializerOptions options)
        => node.ToJsonString(new JsonSerializerOptions(options) { PropertyNamingPolicy = null });
}
