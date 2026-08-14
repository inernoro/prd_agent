using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 串行化同一知识库条目的任务终态切换与产物发布。
///
/// Worker 只有在持有此锁且再次确认 run 仍为 Running 后才可写正文；手动重试的
/// 失联任务回收也必须持有同一把锁。这样旧 Worker 即使在最后一次进度更新后恢复，
/// 也不能越过已经建立的新任务覆盖正文。
/// </summary>
internal static class DocumentStoreRunOutputLease
{
    private const string CollectionName = "document_store_run_output_leases";
    private static readonly TimeSpan LeaseDuration = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan RenewalInterval = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan AcquireTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan RetryInterval = TimeSpan.FromMilliseconds(100);

    internal static async Task<IAsyncDisposable> AcquireAsync(
        MongoDbContext db,
        string entryId,
        string kind,
        CancellationToken cancellationToken)
    {
        var normalizedEntryId = (entryId ?? string.Empty).Trim().ToLowerInvariant();
        var normalizedKind = (kind ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(normalizedEntryId))
            throw new ArgumentException("知识库条目不能为空", nameof(entryId));
        if (string.IsNullOrWhiteSpace(normalizedKind))
            throw new ArgumentException("任务类型不能为空", nameof(kind));

        var key = $"{normalizedKind}:{normalizedEntryId}";
        var collection = db.Database.GetCollection<BsonDocument>(CollectionName);
        var owner = Guid.NewGuid().ToString("N");
        var deadline = DateTime.UtcNow + AcquireTimeout;
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
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
                    cancellationToken);
                if (claimed?.GetValue("owner", string.Empty).AsString == owner)
                    return new LeaseHandle(collection, key, owner, RenewalInterval, LeaseDuration);
            }
            catch (MongoWriteException ex) when (
                ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // 同一条目的终态或产物发布仍在进行，等待其释放。
            }
            catch (MongoCommandException ex) when (ex.Code == 11000)
            {
                // findOneAndUpdate + upsert 的主键竞争由部分 Mongo 版本以 command error 返回。
            }

            await Task.Delay(RetryInterval, cancellationToken);
        }

        throw new TimeoutException("该录音正在完成状态切换，请稍后重试。");
    }

    private sealed class LeaseHandle : IAsyncDisposable
    {
        private readonly IMongoCollection<BsonDocument> _collection;
        private readonly string _key;
        private readonly string _owner;
        private readonly CancellationTokenSource _renewalCts = new();
        private readonly Task _renewalTask;
        private int _released;

        internal LeaseHandle(
            IMongoCollection<BsonDocument> collection,
            string key,
            string owner,
            TimeSpan renewalInterval,
            TimeSpan leaseDuration)
        {
            _collection = collection;
            _key = key;
            _owner = owner;
            _renewalTask = RenewAsync(renewalInterval, leaseDuration);
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _released, 1) != 0) return;
            _renewalCts.Cancel();
            try { await _renewalTask; }
            catch (OperationCanceledException) { }
            catch { /* 代次栅栏仍会阻止旧任务发布，释放流程不能覆盖业务结果。 */ }
            try
            {
                await _collection.DeleteOneAsync(
                    Builders<BsonDocument>.Filter.Eq("_id", _key)
                    & Builders<BsonDocument>.Filter.Eq("owner", _owner),
                    CancellationToken.None);
            }
            catch
            {
                // 释放失败时由 expiresAt 兜底，不能覆盖主业务结果。
            }
        }

        private async Task RenewAsync(TimeSpan interval, TimeSpan duration)
        {
            while (!_renewalCts.IsCancellationRequested)
            {
                await Task.Delay(interval, _renewalCts.Token);
                try
                {
                    var result = await _collection.UpdateOneAsync(
                        Builders<BsonDocument>.Filter.Eq("_id", _key)
                        & Builders<BsonDocument>.Filter.Eq("owner", _owner),
                        Builders<BsonDocument>.Update.Set("expiresAt", DateTime.UtcNow + duration),
                        cancellationToken: _renewalCts.Token);
                    if (result.MatchedCount == 0)
                        return;
                }
                catch (OperationCanceledException) when (_renewalCts.IsCancellationRequested)
                {
                    throw;
                }
                catch
                {
                    // Mongo 短暂抖动时下一轮继续；即使最终失锁，条目代次仍是发布栅栏。
                }
            }
        }
    }
}
