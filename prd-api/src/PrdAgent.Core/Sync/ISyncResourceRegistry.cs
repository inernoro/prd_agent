namespace PrdAgent.Core.Sync;

/// <summary>
/// 可同步资源注册表：按 ResourceType 索引所有 ISyncableResource 实现。
/// 新增资源 = 加实现类 + DI 注册，端点零改动。
/// </summary>
public interface ISyncResourceRegistry
{
    /// <summary>列出所有已注册资源的能力声明。</summary>
    IReadOnlyList<SyncResourceCapability> Capabilities { get; }

    /// <summary>按类型取资源实现，未注册返回 null。</summary>
    ISyncableResource? Resolve(string resourceType);
}
