using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Database;

/// <summary>正文与文件写入共用回收代次保护，恢复后也拒绝删除前发出的请求。</summary>
public static class DocumentEntryWriteGuard
{
    public static FilterDefinition<DocumentEntry> ForCurrentLifecycle(DocumentEntry entry)
    {
        var filter = Builders<DocumentEntry>.Filter;
        var lifecycle = filter.Eq(item => item.LifecycleVersion, entry.LifecycleVersion);
        // 存量条目没有该字段，等价于第零代，不需要批量迁移。
        if (entry.LifecycleVersion == 0)
            lifecycle |= filter.Exists(item => item.LifecycleVersion, false);
        return filter.Eq(item => item.Id, entry.Id)
            & filter.Eq(item => item.Trash, null)
            & lifecycle;
    }
}
