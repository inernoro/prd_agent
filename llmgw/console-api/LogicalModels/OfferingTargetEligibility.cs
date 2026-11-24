using MongoDB.Bson;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.LogicalModels;

/// <summary>
/// 一条线路指着的上游，现在还承接得了流量吗。
///
/// 为什么收成一处：这几条判据原先只长在「新建线路」那一个端点上，而**启用**一条早先停用的
/// 线路走的是另一个端点，它只判了 ASR 契约。于是同一个不可用状态（模型被删了、Provider 被停了、
/// 兑换所那条别名被单独关了）在新建时拦得住、在启用时拦不住——一条停用的坏线路可以被重新打开，
/// 接口回 200、界面上它是启用的，而运行时解析会把它整条丢掉：「存得进去、跑不起来」的老形状，
/// 只是换了个入口进来（形状 3：同一个判断在两个入口各写一份，然后各自漂移）。
///
/// 判据本身不是新的，每一条都对着运行时那一侧：
/// 目标在不在、启不启用，对的是解析时的租户过滤与 Enabled 过滤；Provider 在不在、启不启用，
/// 对的是 FindGatewayOwnedOrMapPlatformAsync(requireEnabled: true)；兑换所别名声明没声明，
/// 对的是 GatewayCatalogGate.ExchangeDeclares（镜像在 <see cref="ExchangeAliasPolicy"/>）。
/// </summary>
public static class OfferingTargetEligibility
{
    /// <summary>不可用的原因：错误码 + 一句给人看的话（含下一步）。全都可用时返回 null。</summary>
    public readonly record struct Rejection(string Code, string Message);

    /// <summary>
    /// 兑换所那一支不判 Provider：它自己就是虚拟平台，没有单独的 Provider 文档。
    /// 物理模型那一支不判别名：别名是兑换所的概念。
    /// </summary>
    public static Rejection? Evaluate(
        string targetKind,
        BsonDocument? target,
        BsonDocument? targetPlatform,
        string? upstreamModelId)
    {
        if (target is null)
            return new Rejection("TARGET_NOT_FOUND", "上游目标不存在或不属于当前租户");
        // 判的是 `== true` 而不是「不等于 false」：缺 Enabled 字段的文档（存量数据、直接写库）
        // 在运行时那条 `Eq(x => x.Enabled, true)` 下一条都匹配不上，这里认它就会放过一条
        // 运行时根本用不了的线路——控制面比运行时松，包票就是假的（第 58 轮 review）。
        if (target.AsNullableBool("Enabled") != true)
            return new Rejection("TARGET_DISABLED", "上游目标已停用，或它的启用状态没有登记");

        if (targetKind == "model")
        {
            if (targetPlatform is null)
            {
                return new Rejection(
                    "TARGET_PLATFORM_UNAVAILABLE",
                    "这个模型没有挂在任何一个可用的 Provider 上（Provider 不存在，或不属于当前租户）。"
                    + "去上游页确认它归属的 Provider——现在这条线路承接不了任何流量，运行时会把它整条丢掉。");
            }
            if (targetPlatform.AsNullableBool("Enabled") != true)
            {
                return new Rejection(
                    "TARGET_PLATFORM_UNAVAILABLE",
                    "这个模型挂的 Provider 已停用，或者它的启用状态没有登记。先在上游页把它启用——"
                    + "这两种情况下运行时都会把这条线路整条丢掉。");
            }
            return null;
        }

        var alias = ExchangeAliasPolicy.EffectiveAlias(target, upstreamModelId);
        if (!ExchangeAliasPolicy.Declares(target, alias))
        {
            return new Rejection(
                "EXCHANGE_ALIAS_NOT_DECLARED",
                alias.Length == 0
                    ? "这个兑换所没有主别名，所以必须指定「上游模型」；不指定的话运行时会把这条线路整条跳过。"
                    : $"兑换所里没有启用着的别名「{alias}」（不存在，或被单独停用了）。"
                      + "去兑换所页确认这条别名的拼写与开关——运行时会把这条线路跳过，"
                      + "这个模型等于少了一条上游。");
        }
        return null;
    }
}
