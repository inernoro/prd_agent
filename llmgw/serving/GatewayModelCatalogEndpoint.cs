using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

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
        IConfiguration config,
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

        // 两道门都要过：授权名单 + 场景能力。
        //
        // 授权范围为空 = 当前租户全部 appCaller 可用；非空就必须点名命中这把 key 的 appCaller。
        // 请求没带 appCaller 时只回不限授权的那部分——宁可少列，不可把受限模型透给不该看的人。
        //
        // 只查授权名单是不够的：一个 image-layering 这样的**动作能力**模型授权名单是空的，
        // 于是它对普通生图调用方也「可见」，而运行时 SupportsAppCallerScenario 会拒掉同一个
        // 调用方——清单里列出来、一调就失败（capability-is-not-model：那种能力需要特定输入、
        // 不吃提示词，它是动作不是模型）。判据本体在 GatewayCapabilityContract，
        // 那份契约的注释自己就写着「serving 也要引用它，禁止任何调用方另写一套」——
        // 这里补上引用，而不是在这里再判一次（形状 3：判据分裂成两份各自漂移）。
        var visible = logicals
            .Where(x => x.AllowedAppCallerCodes.Count == 0
                || (appCallerCode is { Length: > 0 }
                    && x.AllowedAppCallerCodes.Contains(appCallerCode, StringComparer.OrdinalIgnoreCase)))
            .Where(x => appCallerCode is not { Length: > 0 }
                || GatewayCapabilityContract.SupportsAppCallerScenario(
                    x.Capabilities, x.AllowedAppCallerCodes, appCallerCode))
            .OrderBy(x => x.DisplayOrder)
            .ThenBy(x => x.PublicId, StringComparer.Ordinal)
            .ToList();
        if (visible.Count == 0)
            return new JsonObject { ["object"] = "list", ["data"] = new JsonArray() };

        var logicalIds = visible.Select(x => x.Id).ToList();
        var of = Builders<GatewayModelOffering>.Filter;

        // 可用判据必须与运行时解析对齐，不能只看 Enabled。
        //
        // 这个端点的契约是「列出来的都能调」——它自己的注释就写着「列出来就是让对方白调一次」，
        // 但判据此前只过滤 Enabled：熔断掉的线路（HealthStatus=Unavailable）、指向已停用或
        // 已删除的物理模型 / 平台 / 兑换所的线路，全都被当成可用发布出去。对方照着清单调一次，
        // 立刻拿到失败——而我们这边看不出任何异常（predicate-and-wiring-discipline 形状 1：
        // 判据比它该管的范围窄）。
        //
        // 运行时那一侧的判据在 ModelResolver：候选线路 Ne(HealthStatus, Unavailable)，
        // 且目标模型与平台都必须 Enabled，兑换所同理。这里逐条对齐。
        var routes = await offerings
            .Find(of.And(
                of.Eq(x => x.TenantId, tenantId),
                of.In(x => x.LogicalModelId, logicalIds),
                of.Eq(x => x.Enabled, true),
                of.Ne(x => x.HealthStatus, ModelHealthStatus.Unavailable)))
            .ToListAsync(ct);

        // 目标可用性：物理模型与它的平台都得在且启用。
        var targetIds = routes.Where(x => x.TargetKind == "model").Select(x => x.TargetId).Distinct(StringComparer.Ordinal).ToList();
        var bf = Builders<BsonDocument>.Filter;
        var enabledModels = targetIds.Count == 0
            ? new List<BsonDocument>()
            : await physicalModels
                .Find(bf.And(
                    bf.Eq("TenantId", tenantId),
                    bf.In("_id", targetIds),
                    bf.Eq("Enabled", true)))
                .ToListAsync(ct);
        var platformIds = enabledModels
            .Select(x => x.GetValue("PlatformId", BsonNull.Value))
            .Where(x => x.IsString)
            .Select(x => x.AsString)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var enabledPlatformIds = platformIds.Count == 0
            ? new HashSet<string>(StringComparer.Ordinal)
            : (await db.GetCollection<BsonDocument>("llmgw_platforms")
                .Find(bf.And(
                    bf.Eq("TenantId", tenantId),
                    bf.In("_id", platformIds),
                    bf.Eq("Enabled", true)))
                .ToListAsync(ct))
                .Select(x => x.GetValue("_id", BsonNull.Value))
                .Where(x => x.IsString)
                .Select(x => x.AsString)
                .ToHashSet(StringComparer.Ordinal);
        /*
          名录门是运行时的第二道闸，这里也得过一遍。

          它拦的是「绕过控制台进来的模型」——直接写库、历史遗留、别的写入方。那种模型
          启用着、平台也启用着，上面的可用判据一条都拦不住它，于是被当成可调的发布出去；
          而真调用时 ApplyCatalogGateAsync 回 MODEL_NOT_IN_CATALOG。对方照着清单调一次
          必然失败，这正是这个端点的注释说要避免的事（「列出来就是让对方白调一次」）。

          「要不要拦」与运行时同源：配置没降到 observe，且控制台那几条补标记迁移都跑完了。
          降档或迁移没跑完时运行时只记录不拦，这里也就不能少列——否则又走到另一边去了。
        */
        var catalogGateEnforces = await GatewayCatalogGate.EnforcesAsync(config, db, ct);

        var priceByModelId = enabledModels
            .Where(x => x.GetValue("PlatformId", BsonNull.Value) is { IsString: true } pid
                && enabledPlatformIds.Contains(pid.AsString))
            .Where(x => !catalogGateEnforces || GatewayCatalogGate.Passes(x))
            .ToDictionary(x => x.GetValue("_id", BsonNull.Value).AsString, x => x, StringComparer.Ordinal);

        // 兑换所目标：同样要在且启用。
        var exchangeIds = routes.Where(x => x.TargetKind == "exchange").Select(x => x.TargetId).Distinct(StringComparer.Ordinal).ToList();
        var enabledExchangeIds = exchangeIds.Count == 0
            ? new HashSet<string>(StringComparer.Ordinal)
            : (await db.GetCollection<BsonDocument>("llmgw_model_exchanges")
                .Find(bf.And(
                    bf.Eq("TenantId", tenantId),
                    bf.In("_id", exchangeIds),
                    bf.Eq("Enabled", true)))
                .ToListAsync(ct))
                .Select(x => x.GetValue("_id", BsonNull.Value))
                .Where(x => x.IsString)
                .Select(x => x.AsString)
                .ToHashSet(StringComparer.Ordinal);

        var routesByLogical = routes
            .Where(route => string.Equals(route.TargetKind, "exchange", StringComparison.OrdinalIgnoreCase)
                ? enabledExchangeIds.Contains(route.TargetId)
                : priceByModelId.ContainsKey(route.TargetId))
            .GroupBy(x => x.LogicalModelId, StringComparer.Ordinal)
            .ToDictionary(x => x.Key, x => x.OrderBy(r => r.Priority).ToList(), StringComparer.Ordinal);

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
                // 只有**显式**声明 USD 的才报价。
                //
                // 判据原先写成「是字符串且不是 USD 才跳过」——缺币种、null、或存成非字符串的
                // 那几种全都落进了「报价」这一支，而整个 pricing 段的 label 是写死的 "USD"。
                // 那些数字实际可能是人民币（记账侧的存量归一就把缺币种当 CNY），
                // 对方拿去算账差一个数量级（形状 1：判据比它该管的范围窄，「缺失」这种输入
                // 让它给出了相反答案）。宁可这条线路不报价——缺价是看得见的，报错价不是。
                var currency = model.GetValue("PriceCurrency", BsonNull.Value);
                if (!currency.IsString || !string.Equals(currency.AsString.Trim(), "USD", StringComparison.OrdinalIgnoreCase)) continue;

                var prompt = ReadDecimal(model, "InputPricePerMillion");
                var completion = ReadDecimal(model, "OutputPricePerMillion");
                var cached = ReadDecimal(model, "CachedInputPricePerMillion");
                var perCall = ReadDecimal(model, "PricePerCall");
                if (prompt is null && completion is null && perCall is null) continue;

                // via 是给对方看「这条线路走的是哪个上游模型」，必须是人和机器都能用的名字。
                // 不许回落到 TargetId——那是我们的内部 Mongo id，对外既没有意义，也不该泄露。
                // 取值顺序：线路自己覆盖的上游模型名 > 物理模型登记的名字 > 不给这个字段。
                var via = route.UpstreamModelId is { Length: > 0 } overridden
                    ? overridden
                    : model.GetValue("ModelName", BsonNull.Value) is { IsString: true } registered
                        ? registered.AsString
                        : null;
                var routeNode = new JsonObject
                {
                    ["unit"] = perCall is not null ? "per_call" : "per_million_tokens",
                };
                if (via is { Length: > 0 }) routeNode["via"] = via;
                if (perCall is not null)
                {
                    // 按次计费时只报按次价。
                    //
                    // 计价那一侧（GatewayCostCalculator）在有按次价时**完全不看** token 单价，
                    // 这里若把两套价一起报出去，对方读到的是「两种都收」——他按这份清单估出来的
                    // 费用比实际高，而清单与账单说的是两件事。报价要和收费同一个口径，
                    // 不同口径的两份数字必然有一份是假的（形状 3：同一个判据分裂成两份）。
                    routeNode["call"] = perCall.Value.ToString("0.####");
                }
                else
                {
                    if (prompt is not null) routeNode["prompt"] = prompt.Value.ToString("0.####");
                    if (completion is not null) routeNode["completion"] = completion.Value.ToString("0.####");
                    if (cached is not null) routeNode["cached_prompt"] = cached.Value.ToString("0.####");
                }
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
