using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 串行化同一个生成视频对象的“写入并登记引用”与“确认无引用并删除”。
/// 租约文档以资源键作为 MongoDB _id，依靠主键唯一性跨实例互斥；进程异常退出后会自动过期。
/// </summary>
public static class VideoAssetMutationLease
{
    private const string CollectionName = "video_asset_mutation_leases";
    private static readonly TimeSpan LeaseDuration = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan AcquireTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan RetryInterval = TimeSpan.FromMilliseconds(100);

    public static async Task<IAsyncDisposable> AcquireAsync(
        MongoDbContext db,
        string resourceKey,
        CancellationToken ct)
    {
        var key = (resourceKey ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(key))
            throw new ArgumentException("视频资产租约资源键不能为空", nameof(resourceKey));

        var collection = db.Database.GetCollection<BsonDocument>(CollectionName);
        var owner = Guid.NewGuid().ToString("N");
        var deadline = DateTime.UtcNow + AcquireTimeout;
        while (DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            var now = DateTime.UtcNow;
            var filter = Builders<BsonDocument>.Filter.Eq("_id", key)
                         & Builders<BsonDocument>.Filter.Or(
                             Builders<BsonDocument>.Filter.Lte("expiresAt", now),
                             Builders<BsonDocument>.Filter.Eq("owner", owner));
            var update = Builders<BsonDocument>.Update
                .SetOnInsert("_id", key)
                .Set("owner", owner)
                .Set("expiresAt", now + LeaseDuration);
            try
            {
                var claimed = await collection.FindOneAndUpdateAsync(
                    filter,
                    update,
                    new FindOneAndUpdateOptions<BsonDocument>
                    {
                        IsUpsert = true,
                        ReturnDocument = ReturnDocument.After,
                    },
                    ct);
                if (claimed?.GetValue("owner", string.Empty).AsString == owner)
                    return new LeaseHandle(collection, key, owner);
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // 现有未过期租约占用相同 _id；等待持有者释放或租约过期。
            }
            catch (MongoCommandException ex) when (ex.Code == 11000)
            {
                // findAndModify + upsert 的重复键由部分 MongoDB 驱动版本包装为命令异常。
                // 语义仍然是租约正在被占用，必须等待，不能把正常竞争暴露成业务失败。
            }

            await Task.Delay(RetryInterval, ct);
        }

        throw new TimeoutException("视频资产正在被其他任务处理，请稍后重试。");
    }

    public static async Task<bool> HasReferencesAsync(MongoDbContext db, string sha256, string url, CancellationToken ct, bool liveSourcesOnly = false)
    {
        var runFb = Builders<VideoGenRun>.Filter;
        var runFilter = runFb.Or(runFb.Eq(x => x.VideoAssetUrl, url),
            runFb.Eq("Scenes.VideoUrl", url), runFb.Eq("Scenes.Versions.VideoUrl", url));
        if (!string.IsNullOrEmpty(sha256))
            runFilter |= runFb.Or(runFb.Eq(x => x.VideoAssetSha256, sha256), runFb.Eq("Scenes.Versions.AssetSha256", sha256));
        if (liveSourcesOnly) runFilter &= runFb.Eq(x => x.DeletionRequestedAt, null);
        var runReferences = await db.VideoGenRuns.CountDocumentsAsync(runFilter, cancellationToken: ct);
        if (runReferences > 0) return true;

        var projectFb = Builders<VideoProject>.Filter;
        var projectReferences = await db.VideoProjects.CountDocumentsAsync(
            projectFb.Or(
                projectFb.Eq("TimelineTracks.Clips.AssetUrl", url),
                projectFb.Eq("Assets.Url", url)),
            cancellationToken: ct);
        if (projectReferences > 0) return true;

        var exportReferences = await db.VideoExportTasks.CountDocumentsAsync(
            Builders<VideoExportTask>.Filter.Eq(x => x.OutputUrl, url),
            cancellationToken: ct);
        return exportReferences > 0;

    }

    public static async Task<IAsyncDisposable> GuardProjectReferencesAsync(MongoDbContext db, IAssetStorage storage,
        IEnumerable<VideoProjectAsset> assets, IEnumerable<VideoTimelineTrack> tracks, CancellationToken ct)
    {
        var targets = new List<(string Sha, string Url, Action<string> Set)>();
        var inputs = assets.Select(asset => (asset.Url, Set: (Action<string>)(url => asset.Url = url)))
            .Concat(tracks.SelectMany(track => track.Clips).Select(clip => (Url: clip.AssetUrl, Set: (Action<string>)(url => clip.AssetUrl = url))));
        foreach (var (url, set) in inputs)
        {
            if (string.IsNullOrWhiteSpace(url)) continue;
            var reference = TryCanonicalGeneratedReference(storage, url);
            if (reference != null) targets.Add((reference.Value.Sha, reference.Value.Url, set));
        }
        var held = new List<IAsyncDisposable>();
        try
        {
            held.Add(await AcquireReferencesAsync(db, targets.Select(x => x.Url), ct));
            foreach (var target in targets)
            {
                if (!await HasReferencesAsync(db, target.Sha, target.Url, ct, liveSourcesOnly: true))
                    throw new InvalidOperationException("所选生成视频素材已不可用，请重新选择仍在项目或生成记录中的素材。");
                target.Set(target.Url);
            }
            return new ReferenceHandles(held);
        }
        catch
        {
            for (var i = held.Count - 1; i >= 0; i--) await held[i].DisposeAsync();
            throw;
        }
    }

    public static async Task<IAsyncDisposable> AcquireReferencesAsync(MongoDbContext db, IEnumerable<string> urls, CancellationToken ct)
    {
        var held = new List<IAsyncDisposable>();
        try
        {
            foreach (var url in urls.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Split('?', '#')[0]).Distinct().Order(StringComparer.Ordinal))
                held.Add(await AcquireAsync(db, $"generated-video-reference:{url}", ct));
            return new ReferenceHandles(held);
        }
        catch
        {
            for (var i = held.Count - 1; i >= 0; i--) await held[i].DisposeAsync();
            throw;
        }
    }

    internal static (string Sha, string Url)? TryCanonicalGeneratedReference(IAssetStorage storage, string url)
    {
        var clean = url.Split('?', '#')[0];
        var path = Uri.TryCreate(clean, UriKind.Absolute, out var uri) ? uri.AbsolutePath : clean;
        if (!path.Contains("/video-agent/video/", StringComparison.Ordinal)) return null;
        var file = Path.GetFileName(path); var sha = Path.GetFileNameWithoutExtension(file);
        var logical = $"{AppDomainPaths.DomainVideoAgent}/{AppDomainPaths.TypeVideo}/{file}";
        var fullSha = sha.Length == 64 && sha.All(Uri.IsHexDigit);
        if (!fullSha && !AssetStorageDeletePolicy.IsContentAddressedGeneratedVideoKey(logical)) return null;
        var canonical = storage.BuildUrlForLogicalKey(logical);
        return string.Equals(clean, canonical, StringComparison.Ordinal) ? (fullSha ? sha.ToLowerInvariant() : string.Empty, canonical) : null;
    }

    private sealed class ReferenceHandles(List<IAsyncDisposable> held) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            for (var i = held.Count - 1; i >= 0; i--) await held[i].DisposeAsync();
        }
    }

    private sealed class LeaseHandle : IAsyncDisposable
    {
        private readonly IMongoCollection<BsonDocument> _collection;
        private readonly string _key;
        private readonly string _owner;
        private int _released;

        public LeaseHandle(IMongoCollection<BsonDocument> collection, string key, string owner)
        {
            _collection = collection;
            _key = key;
            _owner = owner;
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _released, 1) != 0) return;
            try
            {
                await _collection.DeleteOneAsync(
                    Builders<BsonDocument>.Filter.Eq("_id", _key)
                    & Builders<BsonDocument>.Filter.Eq("owner", _owner),
                    CancellationToken.None);
            }
            catch
            {
                // 释放失败由 expiresAt 自动兜底，不能覆盖主业务结果。
            }
        }
    }
}
