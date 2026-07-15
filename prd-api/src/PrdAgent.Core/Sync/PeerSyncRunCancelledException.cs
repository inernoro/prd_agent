namespace PrdAgent.Core.Sync;

/// <summary>
/// 用户主动取消某个在途同步 run 的信号（跨层）。Api 的取消检查点抛出，Infrastructure 的 apply 逐条
/// catch 需识别并 rethrow 放行（否则会被吞成 per-record failure，取消变成 error 而非 cancelled）。
/// 用独立异常类型（而非 OperationCanceledException）与「HTTP 断开的 ct 取消」区分——后者按现状落 error，
/// 用户主动取消落 cancelled。放在 Core 层，让 Api（抛出点）与 Infrastructure（放行点）都能引用。
/// </summary>
public sealed class PeerSyncRunCancelledException : Exception
{
    public PeerSyncRunCancelledException() : base("同步已被用户取消") { }
}
