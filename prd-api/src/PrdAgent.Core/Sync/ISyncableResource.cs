namespace PrdAgent.Core.Sync;

/// <summary>
/// 可跨节点互传的业务资源。任何应用实现本接口 + DI 注册即可接入系统级互传，
/// PeerSyncController 端点零改动。详见 doc/design.peer-sync.md §5.2。
///
/// 计算/发送分离：ExportAsync 是纯计算（导出 bundle），发送由 PeerSyncController 统一负责；
/// ApplyAsync 是接收侧落库（按用户名对齐归属）。
/// </summary>
public interface ISyncableResource
{
    /// <summary>资源类型标识（kebab-case，如 "document-store"），全局唯一。</summary>
    string ResourceType { get; }

    /// <summary>展示名（如「知识库」）。</summary>
    string DisplayName { get; }

    /// <summary>是否支持双向同步（知识库 true，其它资源先 false）。</summary>
    bool SupportsBidirectional { get; }

    /// <summary>本节点当前 schema 版本。</summary>
    int SchemaVersion { get; }

    /// <summary>列出本节点当前用户【可发送】的条目（供「发送到」弹窗展示）。</summary>
    Task<IReadOnlyList<SyncItemSummary>> ListItemsAsync(SyncActor actor, CancellationToken ct);

    /// <summary>导出一个条目为 bundle（计算阶段）。条目不存在 / 无权访问返回 null。</summary>
    Task<SyncResourceBundle?> ExportAsync(string itemId, SyncActor actor, CancellationToken ct);

    /// <summary>计算条目内容签名（变更检测用，不加载正文，廉价）。条目不存在返回 null。</summary>
    Task<string?> ComputeSignatureAsync(string itemId, CancellationToken ct);

    /// <summary>
    /// 把 bundle 落到本节点（接收阶段），按用户名/邮箱对齐归属。
    /// targetKey 为对端指定的目标条目键（双向 / 指定目标时用；为空则按 bundle.Item.Key 解析或新建）。
    /// </summary>
    Task<SyncApplyOutcome> ApplyAsync(SyncResourceBundle bundle, SyncActor actor, SyncApplyMode mode, string? targetKey, CancellationToken ct);
}
