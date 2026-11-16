using MongoDB.Driver;
using StoreModel = PrdAgent.Core.Models.DocumentStore;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.DocumentStore;

/// <summary>授权由入口负责。本服务只处理可重试的状态转换，绝不清理正文、附件或历史。</summary>
public sealed class DocumentTrashService(MongoDbContext db)
{
    public sealed class ConflictException(string message) : Exception(message);

    public async Task DeleteAsync(string storeId, string? entryId, string actorId)
    {
        var lease = await AcquireAsync(storeId);
        try
        {
            var store = await db.DocumentStoresIncludingTrash.Find(x => x.Id == storeId).FirstOrDefaultAsync();
            if (store == null) throw new ConflictException("知识库不存在");
            if (entryId != null && store.Trash != null) throw new ConflictException("请先恢复知识库");
            var root = entryId == null ? null : await db.DocumentEntriesIncludingTrash.Find(x => x.Id == entryId && x.StoreId == storeId).FirstOrDefaultAsync();
            if (entryId != null && root == null) throw new ConflictException("条目不存在");
            var previous = entryId == null ? store.Trash : root!.Trash;
            if (previous is { Pending: false }) return; // 重复删除不延长恢复期限
            if (previous != null && previous.RootEntryId != entryId)
                throw new ConflictException("请从回收站恢复所属文件夹");
            var state = previous ?? new DocumentTrashState { DeletedBy = actorId, RootEntryId = entryId, Pending = true };
            var entries = await db.DocumentEntriesIncludingTrash.Find(x => x.StoreId == storeId).ToListAsync();
            var targets = entryId == null ? entries.Where(x => x.Trash == null || x.Trash.BatchId == state.BatchId).Select(x => x.Id).ToHashSet()
                : CollectDescendants(entries, entryId);
            state.DocumentCount ??= entries.Count(x => targets.Contains(x.Id)
                && (x.Trash == null || x.Trash.BatchId == state.BatchId));
            var update = Builders<DocumentEntry>.Update.Set(x => x.Trash, state).Inc(x => x.LifecycleVersion, 1);
            if (entryId == null)
                await db.DocumentStoresIncludingTrash.UpdateOneAsync(x => x.Id == storeId && x.Trash == null,
                    Builders<StoreModel>.Update.Set(x => x.Trash, state), cancellationToken: CancellationToken.None);
            else
                await db.DocumentEntriesIncludingTrash.UpdateOneAsync(x => x.Id == entryId && x.StoreId == storeId && x.Trash == null,
                    update, cancellationToken: CancellationToken.None);
            // 先标记再完成；中断后同批重试，既往独立删除的子条目保持独立批次。
            await db.DocumentEntriesIncludingTrash.UpdateManyAsync(x => x.StoreId == storeId && targets.Contains(x.Id) && x.Trash == null,
                update, cancellationToken: CancellationToken.None);
            await EnsureLeaseAsync(storeId, lease);
            // 将批次减量持久化后再记账；重试只应用一次，不覆盖正常新增的 $inc。
            if (entryId == null)
                await db.DocumentStoresIncludingTrash.UpdateOneAsync(x => x.Id == storeId && x.Trash != null && x.Trash.BatchId == state.BatchId,
                    Builders<StoreModel>.Update.Set("Trash.DocumentCount", state.DocumentCount), cancellationToken: CancellationToken.None);
            else
                await db.DocumentEntriesIncludingTrash.UpdateOneAsync(x => x.Id == entryId && x.Trash != null && x.Trash.BatchId == state.BatchId,
                    Builders<DocumentEntry>.Update.Set("Trash.DocumentCount", state.DocumentCount), cancellationToken: CancellationToken.None);
            var countReceipt = state.BatchId + ":delete";
            await ApplyCountChangeAsync(storeId, countReceipt, -state.DocumentCount.Value);
            await db.DocumentEntriesIncludingTrash.UpdateManyAsync(x => x.StoreId == storeId && x.Trash != null && x.Trash.BatchId == state.BatchId,
                Builders<DocumentEntry>.Update.Set("Trash.Pending", false), cancellationToken: CancellationToken.None);
            if (entryId == null)
                await db.DocumentStoresIncludingTrash.UpdateOneAsync(x => x.Id == storeId && x.Trash != null && x.Trash.BatchId == state.BatchId,
                    Builders<StoreModel>.Update.Set("Trash.Pending", false), cancellationToken: CancellationToken.None);
            await CompleteCountChangeAsync(storeId, countReceipt);
        }
        finally { await ReleaseAsync(storeId, lease); }
    }

    public async Task RestoreAsync(string storeId, string? entryId)
    {
        var lease = await AcquireAsync(storeId);
        try
        {
            var store = await db.DocumentStoresIncludingTrash.Find(x => x.Id == storeId).FirstOrDefaultAsync();
            if (store == null) throw new ConflictException("知识库不存在");
            if (entryId != null && store.Trash != null) throw new ConflictException("请先恢复知识库");
            var root = entryId == null ? null : await db.DocumentEntriesIncludingTrash.Find(x => x.Id == entryId && x.StoreId == storeId).FirstOrDefaultAsync();
            if (entryId != null && root == null) throw new ConflictException("条目不存在");
            var state = entryId == null ? store.Trash : root!.Trash;
            if (state == null) return; // 重复恢复无副作用
            if (state.RootEntryId != entryId) throw new ConflictException("请先恢复所属文件夹");
            if (!state.CanRestore(DateTime.UtcNow)) throw new ConflictException(state.Pending ? "删除尚未完成，请重试删除后恢复" : "已超过 30 天恢复期限");
            var parents = new[] { root?.ParentId, root?.Metadata.GetValueOrDefault("github_parent_id") }
                .Where(x => !string.IsNullOrEmpty(x)).Distinct();
            foreach (var parent in parents)
                if (!await db.DocumentEntries.Find(x => x.Id == parent && x.StoreId == storeId).AnyAsync())
                    throw new ConflictException("原目录已被删除，请先恢复原目录");
            await EnsureLeaseAsync(storeId, lease);
            var restoredCount = state.DocumentCount ?? checked((int)await db.DocumentEntriesIncludingTrash.CountDocumentsAsync(
                x => x.StoreId == storeId && x.Trash != null && x.Trash.BatchId == state.BatchId));
            var countReceipt = state.BatchId + ":restore";
            await ApplyCountChangeAsync(storeId, countReceipt, restoredCount);
            // 根对象最后恢复，使部分完成的恢复可以从同一根对象重试。
            await db.DocumentEntriesIncludingTrash.UpdateManyAsync(x => x.StoreId == storeId && x.Id != entryId && x.Trash != null && x.Trash.BatchId == state.BatchId,
                Builders<DocumentEntry>.Update.Set(x => x.Trash, null), cancellationToken: CancellationToken.None);
            if (entryId == null)
                await db.DocumentStoresIncludingTrash.UpdateOneAsync(x => x.Id == storeId && x.Trash != null && x.Trash.BatchId == state.BatchId,
                    Builders<StoreModel>.Update.Set(x => x.Trash, null), cancellationToken: CancellationToken.None);
            else
                await db.DocumentEntriesIncludingTrash.UpdateOneAsync(x => x.Id == entryId && x.Trash != null && x.Trash.BatchId == state.BatchId,
                    Builders<DocumentEntry>.Update.Set(x => x.Trash, null), cancellationToken: CancellationToken.None);
            await CompleteCountChangeAsync(storeId, countReceipt);
        }
        finally { await ReleaseAsync(storeId, lease); }
    }

    internal static HashSet<string> CollectDescendants(IReadOnlyList<DocumentEntry> entries, string rootId)
    {
        var ids = new HashSet<string> { rootId };
        var queue = new Queue<string>();
        queue.Enqueue(rootId);
        while (queue.TryDequeue(out var id))
            foreach (var entry in entries.Where(x => x.ParentId == id || (x.Metadata.TryGetValue("github_parent_id", out var parent) && parent == id)))
                if ((entry.Trash == null || entry.Trash.RootEntryId == rootId) && ids.Add(entry.Id)) queue.Enqueue(entry.Id);
        return ids;
    }

    private async Task ApplyCountChangeAsync(string storeId, string receipt, int delta)
    {
        await db.DocumentStoresIncludingTrash.UpdateOneAsync(
            Builders<StoreModel>.Filter.Eq(x => x.Id, storeId) & Builders<StoreModel>.Filter.Ne("TrashCountReceipts", receipt),
            Builders<StoreModel>.Update.Inc(x => x.DocumentCount, delta).AddToSet(x => x.TrashCountReceipts, receipt)
                .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: CancellationToken.None);
        // 只修正存量异常负计数，不覆盖任何并发新增。
        await db.DocumentStoresIncludingTrash.UpdateOneAsync(x => x.Id == storeId,
            Builders<StoreModel>.Update.Max(x => x.DocumentCount, 0), cancellationToken: CancellationToken.None);
    }

    private Task CompleteCountChangeAsync(string storeId, string receipt) => db.DocumentStoresIncludingTrash.UpdateOneAsync(
        x => x.Id == storeId, Builders<StoreModel>.Update.Pull(x => x.TrashCountReceipts, receipt), cancellationToken: CancellationToken.None);

    private async Task<string> AcquireAsync(string storeId)
    {
        var now = DateTime.UtcNow;
        var token = Guid.NewGuid().ToString("N");
        var result = await db.DocumentStoresIncludingTrash.UpdateOneAsync(x => x.Id == storeId && (x.TrashLeaseUntil == null || x.TrashLeaseUntil < now),
            Builders<StoreModel>.Update.Set(x => x.TrashLeaseToken, token).Set(x => x.TrashLeaseUntil, now.AddMinutes(10)), cancellationToken: CancellationToken.None);
        if (result.MatchedCount == 0) throw new ConflictException("其他回收或恢复操作正在进行，请稍后重试");
        return token;
    }

    private async Task EnsureLeaseAsync(string storeId, string token)
    {
        var now = DateTime.UtcNow;
        var result = await db.DocumentStoresIncludingTrash.UpdateOneAsync(x => x.Id == storeId && x.TrashLeaseToken == token && x.TrashLeaseUntil > now,
            Builders<StoreModel>.Update.Set(x => x.TrashLeaseUntil, now.AddMinutes(10)), cancellationToken: CancellationToken.None);
        if (result.MatchedCount == 0) throw new ConflictException("操作租约已失效，请刷新后重试");
    }

    private Task ReleaseAsync(string storeId, string token) => db.DocumentStoresIncludingTrash.UpdateOneAsync(x => x.Id == storeId && x.TrashLeaseToken == token,
        Builders<StoreModel>.Update.Set(x => x.TrashLeaseToken, null).Set(x => x.TrashLeaseUntil, null), cancellationToken: CancellationToken.None);
}
