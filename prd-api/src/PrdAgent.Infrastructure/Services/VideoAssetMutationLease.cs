using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;

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

            await Task.Delay(RetryInterval, ct);
        }

        throw new TimeoutException("视频资产正在被其他任务处理，请稍后重试。");
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
