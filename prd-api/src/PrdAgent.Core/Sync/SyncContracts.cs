using System.Text.Json;

namespace PrdAgent.Core.Sync;

/// <summary>
/// 跨节点互传通用契约。详见 doc/design.peer-sync.md §5.2 / §7.3。
///
/// 设计原则（compute-then-send + 向下兼容）：
/// - 发起方调用 ISyncableResource.ExportAsync 得到 SyncResourceBundle（计算阶段），
///   再通过 HMAC 调对端的 apply 端点（发送阶段），发送阶段不再 resolve 业务状态。
/// - 每个 bundle / record 带 schemaVersion + Extras 字典：接收方遇到不认识的字段原样保留在
///   Extras，不丢弃、不报错；缺字段用本节点默认值兜底。任一节点升级加字段都不破旧节点。
/// - 归属按用户名/邮箱对齐（不带 userId，userId 跨节点无意义）。
/// </summary>

/// <summary>发起 / 接收互传的操作者上下文（当前登录用户 / 对端归属信息）。</summary>
public sealed record SyncActor(
    string UserId,        // 本节点操作者 userId（接收侧用于兜底归属）
    string UserName,      // 本节点操作者用户名
    string? Email,        // 本节点操作者邮箱（可空）
    bool IsAdmin = false) // 是否持有超级 / 管理权限（资源 ListItemsAsync 据此放行全域 vs. 仅自己）
{
    /// <summary>
    /// 受信对端节点身份（node-to-node 导出时使用）。该路径已被 HMAC 验签门禁，
    /// 只有已配对的可信节点能到达，故导出绕过「按登录用户」的访问校验。
    /// 不可用于接收侧归属兜底（那里要用真实管理员 userId）。
    /// </summary>
    public const string PeerSystemUserId = "__peer_node__";

    public static SyncActor PeerSystem => new(PeerSystemUserId, "对端节点", null, IsAdmin: true);

    public bool IsPeerSystem => UserId == PeerSystemUserId;
}

/// <summary>同步应用模式。</summary>
public enum SyncApplyMode
{
    /// <summary>覆盖式：以发起方为准（共享条目对端被覆盖，两侧新增都保留）。</summary>
    Overwrite = 0,

    /// <summary>仅新增：对端已存在的条目跳过，不覆盖。</summary>
    AddOnly = 1,
}

/// <summary>资源条目摘要（列出本节点当前用户可发送的条目，供「发送到」弹窗展示）。</summary>
public sealed class SyncItemSummary
{
    public string ItemId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    /// <summary>条目内含的记录数（如知识库的文档数），UI 展示用。</summary>
    public int RecordCount { get; set; }
    public DateTime? UpdatedAt { get; set; }
}

/// <summary>资源的可同步能力声明。</summary>
public sealed class SyncResourceCapability
{
    public string ResourceType { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    /// <summary>是否支持双向同步（知识库 true，其它资源先 false）。</summary>
    public bool SupportsBidirectional { get; set; }
    /// <summary>本节点当前 schema 版本。</summary>
    public int SchemaVersion { get; set; } = 1;
}

/// <summary>跨节点传输的一个资源条目（HTTP body，不落库）。</summary>
public sealed class SyncResourceBundle
{
    /// <summary>本 bundle 的 schema 版本（发起方节点的版本）。</summary>
    public int SchemaVersion { get; set; } = 1;

    /// <summary>资源类型，如 "document-store"。</summary>
    public string ResourceType { get; set; } = string.Empty;

    /// <summary>条目级元信息（名称、标签、归属作者用户名/邮箱等）。</summary>
    public SyncBundleItem Item { get; set; } = new();

    /// <summary>条目内的记录（如知识库的每篇文档 / 文件夹）。</summary>
    public List<SyncRecord> Records { get; set; } = new();
}

/// <summary>条目级元信息。</summary>
public sealed class SyncBundleItem
{
    /// <summary>稳定条目键（跨节点对齐用，知识库即 storeId；保留同一 id 便于 test↔prod 同库）。</summary>
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public List<string>? Tags { get; set; }

    /// <summary>归属作者用户名（接收方按此对齐本节点用户）。</summary>
    public string? OwnerUserName { get; set; }
    /// <summary>归属作者邮箱（用户名未命中时按邮箱对齐）。</summary>
    public string? OwnerEmail { get; set; }

    /// <summary>未知 / 扩展字段（向下兼容：接收方不认识就原样保留）。</summary>
    public Dictionary<string, JsonElement> Extras { get; set; } = new();
}

/// <summary>条目内的一条记录（资源无关；知识库映射为一个 DocumentEntry + 正文）。</summary>
public sealed class SyncRecord
{
    /// <summary>稳定血缘 ID（跨节点幂等 upsert 的对齐键）。</summary>
    public string LineageId { get; set; } = string.Empty;
    /// <summary>父记录血缘 ID（树形结构用，无则 null）。</summary>
    public string? ParentLineageId { get; set; }

    public bool IsFolder { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Summary { get; set; }
    public string? ContentType { get; set; }
    public long FileSize { get; set; }
    public List<string>? Tags { get; set; }

    /// <summary>正文内容（文件夹 / 二进制为 null；空字符串是合法的空文本）。</summary>
    public string? Content { get; set; }

    /// <summary>结构化元信息（如知识库 metadata）。</summary>
    public Dictionary<string, string>? Metadata { get; set; }

    /// <summary>未知 / 扩展字段（向下兼容）。</summary>
    public Dictionary<string, JsonElement> Extras { get; set; } = new();
}

/// <summary>apply 结果。</summary>
public sealed class SyncApplyOutcome
{
    public int Created { get; set; }
    public int Updated { get; set; }
    public int Skipped { get; set; }
    public int Failed { get; set; }

    /// <summary>对端 schema 版本高于本节点、部分字段仅保留未解释时为 true。</summary>
    public bool Partial { get; set; }

    /// <summary>未对齐归属的记录数（已归到操作者名下）。</summary>
    public int UnmatchedAuthors { get; set; }

    /// <summary>人类可读摘要。</summary>
    public string? Message { get; set; }
}
