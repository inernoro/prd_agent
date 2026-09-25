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
    private int _substitutionAnnounced;

    public MdToPptPageModelRoute(string? profileModel, bool explicitlySelected)
    {
        RequestedModel = string.IsNullOrWhiteSpace(profileModel) ? null : profileModel.Trim();
        ExplicitlySelected = explicitlySelected;
    }

    public string? RequestedModel { get; }

    public bool ExplicitlySelected { get; }

    /// <summary>
    /// 改道后的请求**真的被网关接住**（收到 Start、知道实际模型）时通知一次，参数是实际模型。
    /// 不在切换那一刻通知：切换只是「换个方式再试」，若网关连不点名的请求也拒绝（例如该用途被停用），
    /// 提前说「已改用默认模型」就是一句谎话。
    /// </summary>
    public Func<string?, Task>? OnSubstituted { get; set; }

    /// <summary>整次运行只宣布一次改判；返回 true 的那一次负责通知。</summary>
    public bool TryMarkSubstitutionAnnounced() =>
        Outcome == MdToPptPageModelOutcome.UseGatewayDefault
        && Interlocked.Exchange(ref _substitutionAnnounced, 1) == 0;

    public MdToPptPageModelOutcome Outcome => (MdToPptPageModelOutcome)Volatile.Read(ref _state);

    /// <summary>按当前路线，页面请求该点名的模型；<c>null</c> 表示不点名、交给网关默认对外模型。</summary>
    public string? ExpectedModelFor(MdToPptPageModelOutcome outcome) =>
        outcome == MdToPptPageModelOutcome.UseProfileModel ? RequestedModel : null;

    /// <summary>改道后的请求被网关接住时给人看的说明（<paramref name="actualModel"/> 是这次实际跑的模型）。</summary>
    public string SubstitutionNotice(string? actualModel) =>
        $"LLM Gateway 没有接住默认运行配置里点名的模型「{RequestedModel}」，本次改由网关为 MD 转 PPT 配置的默认对外模型"
        + (string.IsNullOrWhiteSpace(actualModel) ? "" : $"（实际模型 {actualModel.Trim()}）")
        + " 生成页面。想固定用某个模型，请在模型选择里点名一个网关认识的配置。";

    /// <summary>
    /// 拒绝时给人看的说明。<see cref="GatewayRouteFailure.AppCallerPoolUnbound"/> 不只代表「目录里没有这个名字」，
    /// 调用方在网关被停用、未登记时也是这个码（Codex P2，PR #1629），所以这里把几种可能一并交代，
    /// 不把原因说死成「模型没登记」。
    /// </summary>
    public string? Notice => Outcome switch
    {
        MdToPptPageModelOutcome.Reject when ExplicitlySelected =>
            $"LLM Gateway 没有接住你选的运行配置里的模型「{RequestedModel}」（它不在对外模型目录里、没有授权给 MD 转 PPT，或该用途在网关被停用），页面无法生成。"
            + "请在模型选择里改选「MAP 默认模型」重试；仍然失败请网关管理员检查 MD 转 PPT 调用方的状态。",
        MdToPptPageModelOutcome.Reject =>
            $"LLM Gateway 拒绝了 MD 转 PPT 的页面生成：点名「{RequestedModel}」和交给网关默认对外模型两种方式都没有线路接住，"
            + "通常是该用途在网关被停用、或没有配置默认对外模型。请网关管理员检查 MD 转 PPT 调用方的状态与默认对外模型后重试。",
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
