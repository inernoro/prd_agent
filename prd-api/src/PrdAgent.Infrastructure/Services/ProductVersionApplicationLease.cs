using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>沿用项目Mongo租约模式，同一应用的发号、修改和删除串行；不保存版本号。</summary>
public sealed class ProductVersionApplicationLease : IAsyncDisposable
{
    public const string CollectionName = "product_version_application_leases";
    private static readonly TimeSpan Duration = TimeSpan.FromMinutes(5);
    private readonly List<Holder> holders = new();
    private readonly HashSet<string> applications = new(StringComparer.Ordinal);

    private ProductVersionApplicationLease() { }

    public static async Task<ProductVersionApplicationLease> AcquireAsync(MongoDbContext db,
        IEnumerable<string> applicationIds, TimeSpan? timeout = null)
    {
        var ids = applicationIds.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.Ordinal)
            .OrderBy(x => x, StringComparer.Ordinal).ToList();
        if (ids.Count == 0) throw new InvalidOperationException("请选择所属应用后再申领");
        var lease = new ProductVersionApplicationLease();
        try
        {
            foreach (var id in ids)
            {
                var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(id))).ToLowerInvariant();
                var collection = db.Database.GetCollection<BsonDocument>(CollectionName);
                var owner = Guid.NewGuid().ToString("N");
                var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(30));
                while (true)
                {
                    var now = DateTime.UtcNow;
                    var f = Builders<BsonDocument>.Filter;
                    try
                    {
                        var claimed = await collection.FindOneAndUpdateAsync(f.Eq("_id", key) & f.Lte("expiresAt", now),
                            Builders<BsonDocument>.Update.SetOnInsert("_id", key).Set("owner", owner).Set("expiresAt", now + Duration),
                            new FindOneAndUpdateOptions<BsonDocument> { IsUpsert = true, ReturnDocument = ReturnDocument.After }, CancellationToken.None);
                        if (claimed?.GetValue("owner", "").AsString == owner)
                        {
                            lease.holders.Add(new Holder(collection, key, owner));
                            lease.applications.Add(id);
                            break;
                        }
                    }
                    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey) { }
                    catch (MongoCommandException ex) when (ex.Code == 11000) { }
                    if (DateTime.UtcNow >= deadline)
                        throw new InvalidOperationException("该应用有申领正在处理，请稍后刷新重试，未重复发号");
                    await Task.Delay(TimeSpan.FromMilliseconds(50));
                }
            }
            return lease;
        }
        catch { await lease.DisposeAsync(); throw; }
    }

    internal bool Covers(string applicationId) => applications.Contains(applicationId);

    public async Task EnsureHeldAsync()
    {
        foreach (var holder in holders) await holder.EnsureHeldAsync();
    }

    public async ValueTask DisposeAsync()
    {
        for (var i = holders.Count - 1; i >= 0; i--) await holders[i].DisposeAsync();
        holders.Clear(); applications.Clear();
    }

    private sealed class Holder : IAsyncDisposable
    {
        private readonly IMongoCollection<BsonDocument> collection;
        private readonly string key;
        private readonly string owner;
        private readonly CancellationTokenSource stopping = new();
        private readonly Task renewing;
        private bool lost;

        internal Holder(IMongoCollection<BsonDocument> collection, string key, string owner)
        {
            this.collection = collection; this.key = key; this.owner = owner;
            renewing = RenewAsync();
        }

        internal async Task EnsureHeldAsync()
        {
            if (lost) throw new InvalidOperationException("该应用的处理已由其他请求接管，请刷新后核对，未重复发号");
            var now = DateTime.UtcNow;
            var f = Builders<BsonDocument>.Filter;
            var result = await collection.UpdateOneAsync(f.Eq("_id", key) & f.Eq("owner", owner) & f.Gt("expiresAt", now),
                Builders<BsonDocument>.Update.Set("expiresAt", now + Duration), cancellationToken: CancellationToken.None);
            if (result.MatchedCount != 0) return;
            lost = true;
            throw new InvalidOperationException("该应用的处理已由其他请求接管，请刷新后核对，未重复发号");
        }

        private async Task RenewAsync()
        {
            try
            {
                while (true)
                {
                    await Task.Delay(TimeSpan.FromSeconds(15), stopping.Token);
                    await EnsureHeldAsync();
                }
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
            catch { lost = true; }
        }

        public async ValueTask DisposeAsync()
        {
            stopping.Cancel();
            await renewing;
            try
            {
                await collection.DeleteOneAsync(Builders<BsonDocument>.Filter.Eq("_id", key)
                    & Builders<BsonDocument>.Filter.Eq("owner", owner), CancellationToken.None);
            }
            catch { /* 释放失败时租约会过期；不覆盖已完成业务的结果。 */ }
            stopping.Dispose();
        }
    }
}
