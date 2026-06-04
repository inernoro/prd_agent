namespace PrdAgent.Core.Models;

/// <summary>
/// 知识库同步配对（功能：跨环境 / 本地库↔库 双向同步）。
/// 一条记录表示「本地某个知识库」与「另一个知识库（同环境的另一个库，或远端环境的某个库）」的同步关系。
/// 由持有令牌（粘贴链接）的一方创建，该方即可双向驱动同步（拉取远端 / 推送本地）。
/// </summary>
public class DocumentStoreSyncLink
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>配对创建者 UserId（仅 owner 可管理 / 触发）</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>本地知识库 ID（DocumentStore.Id）</summary>
    public string LocalStoreId { get; set; } = string.Empty;

    /// <summary>配对类型：local（同环境两个库）/ remote（跨环境，HTTP + 令牌）</summary>
    public string LinkType { get; set; } = DocumentSyncLinkType.Local;

    /// <summary>同步方向：push（本地→对端）/ pull（对端→本地）/ both（双向，先拉后推）</summary>
    public string Direction { get; set; } = DocumentSyncDirection.Both;

    /// <summary>对端知识库 ID（local 时是同环境另一个 storeId；remote 时是远端环境的 storeId）</summary>
    public string RemoteStoreId { get; set; } = string.Empty;

    /// <summary>对端知识库名称（冗余，列表展示用）</summary>
    public string? RemoteStoreName { get; set; }

    /// <summary>远端环境基础地址（remote 时必填，如 https://xxx.miduo.org；local 时为空）</summary>
    public string? RemoteBaseUrl { get; set; }

    /// <summary>远端同步令牌（remote 时必填，永久有效；用于调用远端 sync 端点鉴权）</summary>
    public string? RemoteToken { get; set; }

    // ── 变更检测：上次同步成功后两侧各自的签名快照 ──

    /// <summary>上次同步成功时间</summary>
    public DateTime? LastSyncedAt { get; set; }

    /// <summary>上次同步后本地库的内容签名（与当前本地签名不一致 = 本地有改动）</summary>
    public string? LastLocalSignature { get; set; }

    /// <summary>上次同步后对端库的内容签名（与当前对端签名不一致 = 对端有改动）</summary>
    public string? LastRemoteSignature { get; set; }

    /// <summary>状态：never（未同步过）/ synced（已同步）/ pending（待同步）/ error（出错）</summary>
    public string Status { get; set; } = DocumentSyncLinkStatus.Never;

    /// <summary>最近一次同步结果摘要 / 错误信息</summary>
    public string? LastResult { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>配对类型常量</summary>
public static class DocumentSyncLinkType
{
    public const string Local = "local";
    public const string Remote = "remote";
}

/// <summary>同步方向常量</summary>
public static class DocumentSyncDirection
{
    public const string Push = "push";
    public const string Pull = "pull";
    public const string Both = "both";

    public static bool IsValid(string? d) => d == Push || d == Pull || d == Both;
}

/// <summary>配对状态常量</summary>
public static class DocumentSyncLinkStatus
{
    public const string Never = "never";
    public const string Synced = "synced";
    public const string Pending = "pending";
    public const string Error = "error";
}
