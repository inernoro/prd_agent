namespace PrdAgent.Core.Sync;

/// <summary>
/// 用户主动取消某个在途同步 run 的信号（跨层）。Api 的取消检查点抛出，Infrastructure 的 apply 逐条
/// catch 需识别并 rethrow 放行（否则会被吞成 per-record failure，取消变成 error 而非 cancelled）。
/// 用独立异常类型（而非 OperationCanceledException）与「HTTP 断开的 ct 取消」区分——后者按现状落 error，
/// 用户主动取消落 cancelled。放在 Core 层，让 Api（抛出点）与 Infrastructure（放行点）都能引用。
///
/// 携带「取消时已提交的部分增删改计数」：pull/align 在本地写入阶段写了一半被取消时，DB 已部分改动，
/// resource 在放行取消前把已处理计数塞进异常，service 落 cancelled run 时如实记录（否则破坏性 align
/// 取消的历史会显示删除 0，与实际不符，审计误导）。非 apply 阶段取消则各计数为默认 0。
/// </summary>
public sealed class PeerSyncRunCancelledException : Exception
{
    public int Created { get; }
    public int Updated { get; }
    public int Skipped { get; }
    public int Deleted { get; }
    public int Failed { get; }
    public int AssetsRewritten { get; }
    public int AssetRewriteFailed { get; }

    public PeerSyncRunCancelledException() : base("同步已被用户取消") { }

    public PeerSyncRunCancelledException(int created, int updated, int skipped, int deleted, int failed, int assetsRewritten, int assetRewriteFailed)
        : base("同步已被用户取消")
    {
        Created = created;
        Updated = updated;
        Skipped = skipped;
        Deleted = deleted;
        Failed = failed;
        AssetsRewritten = assetsRewritten;
        AssetRewriteFailed = assetRewriteFailed;
    }
}
