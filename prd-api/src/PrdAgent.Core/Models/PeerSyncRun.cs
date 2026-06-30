namespace PrdAgent.Core.Models;

/// <summary>
/// 跨节点同步运行记录（MAP 知识库传输协议的历史台账）。
///
/// 每发起一次 push / pull / both / 强制对齐，或被对端 apply（incoming）都落一条，
/// 供「同步中心」展示当前状态、问题记录和最近审计。
/// 与 DocumentSyncLog（订阅源逐文件变化）是两回事：本表记录的是节点间整库互传。
/// </summary>
public class PeerSyncRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>资源类型（如 document-store）。</summary>
    public string ResourceType { get; set; } = "document-store";

    /// <summary>本端条目 ID（知识库 storeId）。</summary>
    public string ItemId { get; set; } = string.Empty;

    /// <summary>条目名（冗余，列表直接展示，不必再查 store）。</summary>
    public string ItemName { get; set; } = string.Empty;

    /// <summary>
    /// 同步方向 / 动作：
    /// push（发送到对端）/ pull（从对端拉回）/ both（双向）/ received（接收审计）/
    /// align-remote（强制对齐·远端为准）/ align-local（强制对齐·本地为准）/ align-both（强制对齐·同时对准）。
    /// </summary>
    public string Direction { get; set; } = string.Empty;

    /// <summary>发起方向：outgoing（本端用户发起）/ incoming（对端节点推来）。</summary>
    public string Origin { get; set; } = PeerSyncOrigin.Outgoing;

    /// <summary>对端节点稳定 ID（RemoteNodeId）。</summary>
    public string PeerNodeId { get; set; } = string.Empty;

    /// <summary>对端节点展示名（冗余）。</summary>
    public string PeerNodeName { get; set; } = string.Empty;

    /// <summary>对端节点地址（冗余）。</summary>
    public string? PeerNodeBaseUrl { get; set; }

    /// <summary>状态：syncing / synced / skipped / error。</summary>
    public string Status { get; set; } = PeerSyncRunStatus.Syncing;

    public int Created { get; set; }
    public int Updated { get; set; }
    public int Skipped { get; set; }
    /// <summary>镜像对齐删除的条目数（仅强制对齐的 remote/local 模式会 > 0）。</summary>
    public int Deleted { get; set; }
    public int Failed { get; set; }
    public int AssetsRewritten { get; set; }
    public int AssetRewriteFailed { get; set; }

    /// <summary>当前阶段：准备导出 / 发送到对端 / 从对端拉取 / 本地写入 / 已完成。</summary>
    public string? ProgressPhase { get; set; }

    /// <summary>当前已处理记录数。知识库场景下对应已处理文档 / 文件夹数量。</summary>
    public int ProgressCurrent { get; set; }

    /// <summary>本轮待处理记录总数。未知时为 0。</summary>
    public int ProgressTotal { get; set; }

    /// <summary>当前正在处理的记录标题。</summary>
    public string? CurrentRecordTitle { get; set; }

    /// <summary>人类可读摘要。</summary>
    public string? Message { get; set; }

    /// <summary>触发用户 ID（incoming 为对端配对管理员）。</summary>
    public string TriggeredByUserId { get; set; } = string.Empty;

    /// <summary>触发用户展示名（冗余）。</summary>
    public string? TriggeredByName { get; set; }

    /// <summary>耗时（毫秒）。</summary>
    public int DurationMs { get; set; }

    public DateTime StartedAt { get; set; } = DateTime.UtcNow;

    public DateTime? FinishedAt { get; set; }
}

public static class PeerSyncOrigin
{
    /// <summary>本端用户发起（发送 / 拉取 / 对齐）。</summary>
    public const string Outgoing = "outgoing";

    /// <summary>对端节点推来（被 apply）。</summary>
    public const string Incoming = "incoming";
}

public static class PeerSyncRunStatus
{
    public const string Syncing = "syncing";
    public const string Synced = "synced";
    public const string Skipped = "skipped";
    public const string Error = "error";
}
