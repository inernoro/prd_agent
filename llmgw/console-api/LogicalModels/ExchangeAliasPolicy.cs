using MongoDB.Bson;

namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>
/// 一条兑换所线路实际会打给上游的是哪一个别名，以及那个别名有没有被这个兑换所声明过。
///
/// 唯一权威定义在 <c>prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayCatalogGate.cs</c>
/// 的 <c>EffectiveExchangeModelId</c> / <c>ExchangeDeclares</c>（运行时解析、对外清单、
/// 就绪探针都直接引用它）。本项目按既定架构不引用 PrdAgent.*，所以这里是一份**镜像**，
/// 由 <c>ExchangeAliasPolicyMirrorTests</c> 逐例对照权威实现——两边给出不同结论就红。
///
/// 为什么写入侧非判不可：不判的话，管理员把 UpstreamModelId 打错一个字、或选了一条已被
/// 单独停用的别名，这条线路照样存得进去、接口还回 201；而运行时按同一份判据把它整条跳过，
/// 那个刚保存的模型立刻没有可用上游——「存得进去、跑不起来」，而且没有任何地方会说为什么。
/// </summary>
public static class ExchangeAliasPolicy
{
    /// <summary>
    /// 线路实际会打出去的别名：显式写了 UpstreamModelId 就用它，否则回落到兑换所主别名。
    /// 与权威实现 <c>EffectiveExchangeModelId</c> 同序。
    /// </summary>
    public static string EffectiveAlias(BsonDocument exchange, string? upstreamModelId)
    {
        var explicitAlias = (upstreamModelId ?? string.Empty).Trim();
        if (explicitAlias.Length > 0) return explicitAlias;
        var value = exchange.GetValue("ModelAlias", BsonNull.Value);
        return value.IsString ? value.AsString : string.Empty;
    }

    /// <summary>
    /// 这个兑换所声明过这条别名，而且那一条是启用着的吗。
    ///
    /// 逐条对齐权威实现的取值：
    ///   · <c>Models</c> 非空时**只认它**，两个旧字段短路掉（GetEffectiveModels 的第一句）；
    ///   · <c>Models</c> 为空才从 <c>ModelAlias</c> + <c>ModelAliases</c> 合成，合成出来的一律启用；
    ///   · 只比 <c>ModelId</c>，不比 <c>DisplayName</c>；
    ///   · 比较用 OrdinalIgnoreCase；
    ///   · 条目上的 <c>Enabled:false</c> 单独把这一条关掉（缺字段视为启用）。
    /// </summary>
    public static bool Declares(BsonDocument exchange, string? modelId)
    {
        var wanted = (modelId ?? string.Empty).Trim();
        if (wanted.Length == 0) return false;

        if (exchange.GetValue("Models", BsonNull.Value) is BsonArray { Count: > 0 } models)
        {
            return models.OfType<BsonDocument>().Any(item =>
                (item.GetValue("Enabled", BsonNull.Value) is not BsonBoolean enabled || enabled.Value)
                && item.GetValue("ModelId", BsonNull.Value) is BsonString id
                && string.Equals(id.AsString, wanted, StringComparison.OrdinalIgnoreCase));
        }

        if (exchange.GetValue("ModelAlias", BsonNull.Value) is BsonString primary
            && primary.AsString.Length > 0
            && string.Equals(primary.AsString, wanted, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return exchange.GetValue("ModelAliases", BsonNull.Value) is BsonArray aliases
            && aliases.OfType<BsonString>().Any(x =>
                x.AsString.Length > 0 && string.Equals(x.AsString, wanted, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// 名录外的这条别名有没有被显式放行（名录门要用）。
    ///
    /// 与权威实现 <c>GatewayCatalogGate.ExchangeAliasAllowedOutsideCatalog</c> 同序：
    /// 旧形态兑换所（<c>Models</c> 为空、别名只在两个旧字段里，没有地方盖逐条标记）整体视为放行——
    /// 它们同样是在逐条放行落地**之前**声明的，与名录门上线前已入库的模型同一处境；
    /// 新形态则必须那一条自己带着 <c>AllowedOutsideCatalog</c> 标记。
    /// </summary>
    public static bool AliasAllowedOutsideCatalog(BsonDocument exchange, string? modelId)
    {
        if (exchange.GetValue("Models", BsonNull.Value) is not BsonArray { Count: > 0 } models) return true;

        var wanted = (modelId ?? string.Empty).Trim();
        if (wanted.Length == 0) return false;

        return models.OfType<BsonDocument>().Any(item =>
            (item.GetValue("Enabled", BsonNull.Value) is not BsonBoolean enabled || enabled.Value)
            && item.GetValue("ModelId", BsonNull.Value) is BsonString id
            && string.Equals(id.AsString, wanted, StringComparison.OrdinalIgnoreCase)
            && item.GetValue("AllowedOutsideCatalog", BsonNull.Value) is BsonBoolean allowed
            && allowed.Value);
    }
}
