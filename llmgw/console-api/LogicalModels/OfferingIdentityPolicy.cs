using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>
/// 一条线路**实际打给上游的是哪一个模型**，以及「两条线路是不是同一个上游」怎么判。
///
/// 线路身份（唯一索引 uniq_llmgw_offering_tenant_logical_target_v3）里存的是 UpstreamModelId
/// 的**原值**：没写就是 null。但运行时不是这么读的——`ModelResolver` 拿到空值时会回落：
/// 兑换所目标回落到 `ModelAlias`，物理模型目标回落到 `ModelName`（两处都在
/// `TryBuildLogicalOfferingResolutionAsync` 里）。
///
/// 于是「没写」的那条和「显式写了同一个名字」的那条，**运行时是同一个上游，索引却是两个身份**。
/// 按原值逐字判重的话，管理员可以先建一条不写的、再建一条写上同名的，两条都进得去：
/// 加权路由把同一个上游算两份权重，故障转移「换一条」换到的还是它（第 66 轮 review，形状 1：
/// 判据比它该管的范围窄——「语义相同、写法不同」的输入让它给出了相反答案）。
///
/// 所以判重收敛到这里：**按运行时会打出去的那个名字比**，控制面因此比索引严一档。
/// 反过来不成立——控制面可以比运行时严，绝不能比它松。
///
/// 存的值不动（仍存原值）：把回落后的名字固化进去会把「跟着目标走」变成「建那一刻钉死」，
/// 目标改名之后这条线路还指着旧名字，那是另一种语义，不在这一刀里改。代价是**数据库那一层
/// 仍然看不穿回落**，并发下两个人同时建仍可能各插一条——已记 `doc/debt.platform.llm-gateway.md`。
/// </summary>
public static class OfferingIdentityPolicy
{
    /// <summary>
    /// 线路没写 UpstreamModelId 时，运行时回落到目标身上的哪个字段。
    /// 与 ModelResolver 的两处回落同序：兑换所取 ModelAlias，物理模型取 ModelName。
    /// </summary>
    public static string FallbackUpstreamModelId(string? targetKind, BsonDocument? target)
    {
        if (target is null) return string.Empty;
        var field = string.Equals(targetKind?.Trim(), "exchange", StringComparison.OrdinalIgnoreCase)
            ? "ModelAlias"
            : "ModelName";
        return target.GetValue(field, BsonNull.Value) is BsonString value ? value.AsString.Trim() : string.Empty;
    }

    /// <summary>这条线路实际会打给上游的模型名：显式写了就用它，否则用目标的回落名。</summary>
    public static string EffectiveUpstreamModelId(string? targetKind, BsonDocument? target, string? upstreamModelId)
    {
        var explicitId = (upstreamModelId ?? string.Empty).Trim();
        return explicitId.Length > 0 ? explicitId : FallbackUpstreamModelId(targetKind, target);
    }

    /// <summary>
    /// 「同一个上游」的查询条件（只负责 UpstreamModelId 这一维，其余维度由调用方拼）。
    ///
    /// 命中两类既有线路：显式写着同一个名字的（不分大小写——别名比对一路都是
    /// OrdinalIgnoreCase），以及没写、而回落名正好就是这个名字的。
    /// </summary>
    public static FilterDefinition<BsonDocument> SameUpstreamFilter(
        string? targetKind, BsonDocument? target, string? upstreamModelId)
    {
        var fb = Builders<BsonDocument>.Filter;
        var explicitId = (upstreamModelId ?? string.Empty).Trim();
        var fallback = FallbackUpstreamModelId(targetKind, target);
        var effective = explicitId.Length > 0 ? explicitId : fallback;

        // 目标连名字都没有：回落解析不出东西，退回逐字比对（与唯一索引同口径）。
        if (effective.Length == 0)
        {
            return fb.Eq("UpstreamModelId", explicitId.Length > 0 ? (BsonValue)explicitId : BsonNull.Value);
        }

        var clauses = new List<FilterDefinition<BsonDocument>>
        {
            fb.Regex("UpstreamModelId", new BsonRegularExpression("^" + Regex.Escape(effective) + "$", "i")),
        };

        // 没写的那些线路，运行时回落到的正是 fallback；它等于 effective 时二者同一个上游。
        if (string.Equals(effective, fallback, StringComparison.OrdinalIgnoreCase))
        {
            clauses.Add(fb.Or(
                fb.Eq("UpstreamModelId", BsonNull.Value),
                fb.Not(fb.Exists("UpstreamModelId"))));
        }

        return fb.Or(clauses);
    }
}
