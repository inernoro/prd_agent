using PrdAgent.Core.Sync;

namespace PrdAgent.Infrastructure.Sync;

/// <summary>
/// 可同步资源注册表：DI 注入所有 ISyncableResource 实现，按 ResourceType 索引。
/// 新增资源 = 加实现类 + DI 注册（AddScoped&lt;ISyncableResource, XxxResource&gt;），本类零改动。
/// </summary>
public class SyncResourceRegistry : ISyncResourceRegistry
{
    private readonly Dictionary<string, ISyncableResource> _byType;

    public SyncResourceRegistry(IEnumerable<ISyncableResource> resources)
    {
        _byType = new Dictionary<string, ISyncableResource>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in resources)
            _byType[r.ResourceType] = r; // 后注册覆盖同类型（允许替换实现）
    }

    public IReadOnlyList<SyncResourceCapability> Capabilities =>
        _byType.Values.Select(r => new SyncResourceCapability
        {
            ResourceType = r.ResourceType,
            DisplayName = r.DisplayName,
            SupportsBidirectional = r.SupportsBidirectional,
            SchemaVersion = r.SchemaVersion,
        }).ToList();

    public ISyncableResource? Resolve(string resourceType)
        => _byType.TryGetValue(resourceType, out var r) ? r : null;
}
