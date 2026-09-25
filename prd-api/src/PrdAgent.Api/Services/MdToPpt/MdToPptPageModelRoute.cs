using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Services.MdToPpt;

/// <summary>页面生成走 LLM Gateway 直出时，这次运行当前按哪条路线点名模型。</summary>
internal enum MdToPptPageModelOutcome
{
    /// <summary>按运行配置里的模型点名（配置没写模型时本来就交给网关按调用方默认对外模型选）。</summary>
    UseProfileModel,

    /// <summary>运行配置是隐式兜底来的，它点名的模型网关接不住；改为不点名，由网关按该用途的默认对外模型选。</summary>
    UseGatewayDefault,

    /// <summary>再发也必然失败，整次运行如实拒绝，不再让每一页各自退化成兜底版式。</summary>
    Reject,
}

/// <summary>
/// 一次 PPT 运行共享的页面模型路线（并行的几页共用同一个实例）。
///
/// 为什么不在发之前先问网关：<c>ResolveModelAsync</c> 不是只读的——它会替熔断冷却期满的线路抢
/// 半开试探租约，而预检之后并不会真的发请求把试探做完，随后真正的页面请求反而抢不到那条线路
/// （Codex P1，PR #1629）。所以这里只用**真实发送**的结果来判定：页面请求被网关以
/// <see cref="GatewayRouteFailure.AppCallerPoolUnbound"/>（点名的模型没有对外模型能接住）拒绝时，
/// 路线切换一次，全体页面随之改道。判据只有 <see cref="Decide"/> 一处。
/// </summary>
internal sealed class MdToPptPageModelRoute
{
    private int _state = (int)MdToPptPageModelOutcome.UseProfileModel;

    public MdToPptPageModelRoute(string? profileModel, bool explicitlySelected)
    {
        RequestedModel = string.IsNullOrWhiteSpace(profileModel) ? null : profileModel.Trim();
        ExplicitlySelected = explicitlySelected;
    }

    public string? RequestedModel { get; }

    public bool ExplicitlySelected { get; }

    /// <summary>路线第一次从「按配置点名」切到「网关默认」时通知一次（用于把改判告诉用户）。</summary>
    public Func<Task>? OnSubstituted { get; set; }

    public MdToPptPageModelOutcome Outcome => (MdToPptPageModelOutcome)Volatile.Read(ref _state);

    /// <summary>按当前路线，页面请求该点名的模型；<c>null</c> 表示不点名、交给网关默认对外模型。</summary>
    public string? ExpectedModelFor(MdToPptPageModelOutcome outcome) =>
        outcome == MdToPptPageModelOutcome.UseProfileModel ? RequestedModel : null;

    /// <summary>给人看的说明：改判或拒绝时说清是谁点名了什么、这次怎么办、下一步做什么。</summary>
    public string? Notice => Outcome switch
    {
        MdToPptPageModelOutcome.UseGatewayDefault =>
            $"默认运行配置里的模型「{RequestedModel}」不在 LLM Gateway 的对外模型目录里，本次改由网关按 MD 转 PPT 的默认对外模型生成页面（实际模型见模型标签）。"
            + "想固定用某个模型，请在模型选择里点名一个网关认识的配置。",
        MdToPptPageModelOutcome.Reject when ExplicitlySelected =>
            $"你选的运行配置里的模型「{RequestedModel}」不在 LLM Gateway 的对外模型目录里（或没有授权给 MD 转 PPT），页面无法生成。"
            + "请在模型选择里改选「MAP 默认模型」，或请网关管理员把它登记为对外模型后重试。",
        MdToPptPageModelOutcome.Reject =>
            $"默认运行配置里的模型「{RequestedModel}」不在 LLM Gateway 的对外模型目录里，网关也没有能接住 MD 转 PPT 的默认对外模型，页面无法生成。"
            + "请网关管理员给该用途设默认对外模型，或把该模型登记为对外模型后重试。",
        _ => null,
    };

    /// <summary>
    /// 唯一判定源：某一页按 <paramref name="attemptedWith"/> 路线发出去、被网关以 <paramref name="gatewayErrorCode"/> 拒绝后，
    /// 路线应该变成什么。只有「点名的模型没有对外模型接得住」这一种拒绝会改道；其余失败（上游故障、配额、配置面读不到）
    /// 换个名字也救不了，路线不动。
    /// </summary>
    internal static MdToPptPageModelOutcome Decide(
        string? requestedModel,
        bool explicitlySelected,
        MdToPptPageModelOutcome attemptedWith,
        string? gatewayErrorCode)
    {
        if (attemptedWith == MdToPptPageModelOutcome.Reject) return MdToPptPageModelOutcome.Reject;
        if (string.IsNullOrWhiteSpace(requestedModel)) return attemptedWith;
        if (!string.Equals(gatewayErrorCode, GatewayRouteFailure.AppCallerPoolUnbound, StringComparison.Ordinal))
            return attemptedWith;
        return attemptedWith == MdToPptPageModelOutcome.UseProfileModel && !explicitlySelected
            ? MdToPptPageModelOutcome.UseGatewayDefault
            : MdToPptPageModelOutcome.Reject;
    }

    /// <summary>
    /// 记录一次网关拒绝，返回此刻的路线与「是否由这一次触发了切换」。
    /// 别的页已经先切过时不重复切：这一页按新路线重试即可。
    /// </summary>
    public (MdToPptPageModelOutcome Outcome, bool Changed) OnGatewayRejected(
        MdToPptPageModelOutcome attemptedWith,
        string? gatewayErrorCode)
    {
        var next = Decide(RequestedModel, ExplicitlySelected, attemptedWith, gatewayErrorCode);
        if (next == attemptedWith) return (Outcome, false);
        var previous = Interlocked.CompareExchange(ref _state, (int)next, (int)attemptedWith);
        return previous == (int)attemptedWith ? (next, true) : (Outcome, false);
    }
}
