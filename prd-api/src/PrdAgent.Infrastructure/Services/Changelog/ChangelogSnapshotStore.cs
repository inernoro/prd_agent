using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.Changelog;

/// <summary>
/// 更新中心快照的终身存储层。封装对 <c>changelog_snapshots</c> 集合的读写。
///
/// 职责单一：只管「按 key 存 / 取一条快照」+「内容指纹比对」。
/// 不负责拉取（那是 ChangelogReader）、不负责推送（那是 ChangelogPushHub）。
/// </summary>
public interface IChangelogSnapshotStore
{
    /// <summary>读取某视图的最新快照（终身存量）；无则返回 null。</summary>
    Task<ChangelogSnapshot?> GetAsync(string key, CancellationToken ct = default);

    /// <summary>
    /// 内容有变化才写库（按 <paramref name="contentHash"/> 比对旧记录）。
    /// 返回 true 表示内容确实变了（首次写入也算变化）。
    /// </summary>
    Task<bool> UpsertIfChangedAsync(
        string key,
        string payloadJson,
        string contentHash,
        string source,
        DateTime fetchedAt,
        CancellationToken ct = default);

    /// <summary>对内容文本求稳定指纹（SHA256 hex）。</summary>
    static string ComputeHash(string content)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(content));
        return Convert.ToHexString(bytes);
    }
}

public sealed class ChangelogSnapshotStore : IChangelogSnapshotStore
{
    private readonly MongoDbContext _db;
    private readonly ILogger<ChangelogSnapshotStore> _logger;

    public ChangelogSnapshotStore(MongoDbContext db, ILogger<ChangelogSnapshotStore> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<ChangelogSnapshot?> GetAsync(string key, CancellationToken ct = default)
    {
        try
        {
            // 防御性读取：按 UpdatedAt 倒序取，万一在没有唯一索引的环境里发生过 upsert 竞态
            // 产生了同 Key 重复行，也只会命中「最新写入」的那条，不会 hydrate 到任意旧行。
            // 根治靠 changelog_snapshots.Key 唯一索引（见 doc/guide.mongodb-indexes.md，DBA 手建）。
            return await _db.ChangelogSnapshots
                .Find(x => x.Key == key)
                .SortByDescending(x => x.UpdatedAt)
                .FirstOrDefaultAsync(ct)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] 读取快照失败 key={Key}（降级为无存量）", key);
            return null;
        }
    }

    public async Task<bool> UpsertIfChangedAsync(
        string key,
        string payloadJson,
        string contentHash,
        string source,
        DateTime fetchedAt,
        CancellationToken ct = default)
    {
        try
        {
            // 与 GetAsync 一致：按 UpdatedAt 倒序取最新行做指纹比对，保证「变化检测」与「hydrate 读取」
            // 命中同一条（最新）记录。缺唯一索引、存在重复行时也不会比错行导致漏推/留旧 payload。
            var existing = await _db.ChangelogSnapshots
                .Find(x => x.Key == key)
                .SortByDescending(x => x.UpdatedAt)
                .FirstOrDefaultAsync(ct)
                .ConfigureAwait(false);

            var changed = existing == null || existing.ContentHash != contentHash;

            // 即便内容未变，也刷新 FetchedAt/UpdatedAt（让「更新时间」反映最近一次成功拉取），
            // 但 changed=false 时不触发推送（由调用方根据返回值决定）。
            var update = Builders<ChangelogSnapshot>.Update
                .Set(x => x.Key, key)
                .Set(x => x.PayloadJson, payloadJson)
                .Set(x => x.ContentHash, contentHash)
                .Set(x => x.Source, source)
                .Set(x => x.FetchedAt, fetchedAt)
                .Set(x => x.UpdatedAt, DateTime.UtcNow)
                .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"));

            await _db.ChangelogSnapshots.UpdateOneAsync(
                x => x.Key == key,
                update,
                new UpdateOptions { IsUpsert = true },
                ct).ConfigureAwait(false);

            return changed;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] 写入快照失败 key={Key}（不影响本次返回）", key);
            return false;
        }
    }
}
