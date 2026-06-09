namespace PrdAgent.Core.Models;

/// <summary>
/// 对端节点（系统级跨节点互传）。
/// 一条记录 = 本节点记录的「我认识的另一个 MAP 实例」（如测试环境记录正式环境）。
/// 配对成功后，两个节点各存一条互指的 PeerNode，持有相同的 SharedSecret，
/// 后续所有跨节点数据请求用 HMAC-SHA256 签名鉴权，不再传明文令牌。
/// 详见 doc/design.peer-sync.md。
/// </summary>
public class PeerNode
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>对端节点稳定标识（对端的 selfNodeId）</summary>
    public string RemoteNodeId { get; set; } = string.Empty;

    /// <summary>对端展示名（如「正式环境」），配对时由对端 handshake 返回 / 本端可改</summary>
    public string DisplayName { get; set; } = string.Empty;

    /// <summary>对端 baseUrl（含可能的子路径前缀，如 https://xxx.miduo.org/prod）</summary>
    public string BaseUrl { get; set; } = string.Empty;

    /// <summary>双方共享密钥（base64，仅后端可见，永不出现在 URL / 日志 / 前端）。HMAC 签名用。</summary>
    public string SharedSecret { get; set; } = string.Empty;

    /// <summary>状态：pending（待握手）/ connected（已连接）/ error（通信异常）</summary>
    public string Status { get; set; } = PeerNodeStatus.Pending;

    /// <summary>最近一次通信错误信息</summary>
    public string? LastError { get; set; }

    /// <summary>最近一次成功通信时间</summary>
    public DateTime? LastContactAt { get; set; }

    /// <summary>配对发起的管理员 userId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>对端节点状态常量</summary>
public static class PeerNodeStatus
{
    public const string Pending = "pending";
    public const string Connected = "connected";
    public const string Error = "error";
}

/// <summary>
/// 一次性配对码（管理员握手用，短 TTL，握手成功即失效）。
/// 集合 peer_pairing_codes，Id 即配对码本身。
/// </summary>
public class PeerPairingCode
{
    /// <summary>配对码（即主键，高熵随机串）</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>生成该配对码的管理员 userId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>过期时间（默认 5 分钟）</summary>
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddMinutes(5);

    /// <summary>是否已被使用（一次性）</summary>
    public bool Used { get; set; }

    /// <summary>使用方（握手成功后记录对端 nodeId，审计用）</summary>
    public string? UsedByNodeId { get; set; }

    /// <summary>两阶段握手 prepare 阶段暂存的发起方回连地址。</summary>
    public string? PendingInitiatorBaseUrl { get; set; }

    /// <summary>两阶段握手 prepare 阶段暂存的发起方展示名。</summary>
    public string? PendingInitiatorDisplayName { get; set; }

    /// <summary>两阶段握手 prepare 阶段生成的共享密钥；confirm 成功后才落 PeerNode。</summary>
    public string? PendingSharedSecret { get; set; }

    /// <summary>confirm 阶段若替换了已有节点，记录旧节点 ID 以便 cancel 回滚。</summary>
    public string? PendingReplacedPeerNodeId { get; set; }

    /// <summary>confirm 阶段替换已有节点前的展示名。</summary>
    public string? PendingPreviousDisplayName { get; set; }

    /// <summary>confirm 阶段替换已有节点前的地址。</summary>
    public string? PendingPreviousBaseUrl { get; set; }

    /// <summary>confirm 阶段替换已有节点前的共享密钥。</summary>
    public string? PendingPreviousSharedSecret { get; set; }

    /// <summary>confirm 阶段替换已有节点前的状态。</summary>
    public string? PendingPreviousStatus { get; set; }

    /// <summary>confirm 阶段替换已有节点前的最后错误。</summary>
    public string? PendingPreviousLastError { get; set; }

    /// <summary>confirm 阶段替换已有节点前的最后通信时间。</summary>
    public DateTime? PendingPreviousLastContactAt { get; set; }

    /// <summary>confirm 阶段替换已有节点前的创建人。</summary>
    public string? PendingPreviousCreatedBy { get; set; }

    /// <summary>两阶段握手 confirm 完成时间。</summary>
    public DateTime? ConfirmedAt { get; set; }

    /// <summary>发起端完成探活和本地落库后写入；写入后 cancel 不能再撤销正式连接。</summary>
    public DateTime? FinalizedAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
