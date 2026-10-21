using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 依靠 MongoDB 原生 _id 唯一性永久占用申领来源，跨实例和新旧入口共用。
/// 不使用可过期锁：写入结果不明确时保持占用，避免超时后的第二次发号。
/// </summary>
public static class ProductVersionClaimGuard
{
    public const string CollectionName = "product_version_claims";

    /// <summary>T/V各自按全局数字最大值递增；先永久占号，软删除和未落业务行的占号均不能复用。</summary>
    public static async Task<string> ReserveWorkflowCodeAsync(MongoDbContext db, string prefix, string versionType, string targetId)
    {
        if (prefix is not ("T" or "V")) throw new ArgumentException("不支持的版本编号类型", nameof(prefix));
        var keyPrefix = "workflow-code:" + prefix + ":";
        var claims = db.Database.GetCollection<BsonDocument>(CollectionName);
        var codeClaims = Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression("^" + keyPrefix));
        var reserved = await claims.Find(codeClaims & Builders<BsonDocument>.Filter.Eq("targetId", targetId)).FirstOrDefaultAsync();
        if (reserved != null) return reserved["_id"].AsString[keyPrefix.Length..];
        for (var attempt = 0; attempt < 64; attempt++)
        {
            // 编号永久占用，不按产品、状态或软删除过滤。
            var existing = prefix == "T"
                ? await db.ProductInitiations.Find(x => x.TCode != null).Project(x => x.TCode!).ToListAsync()
                : await db.ProductReleases.Find(x => x.VCode != "").Project(x => x.VCode).ToListAsync();
            var legacy = await db.VersionRegistrations.Find(x => x.Code.StartsWith(prefix)).Project(x => x.Code).ToListAsync();
            var allocations = await claims.Find(codeClaims).ToListAsync();
            var candidate = ProductEntityNumbering.NextWorkflowCode(prefix, versionType,
                existing.Concat(legacy).Concat(allocations.Select(x => x["_id"].AsString[keyPrefix.Length..])));
            if (await TryReserveAsync(db.Database, keyPrefix + candidate, targetId)) return candidate;
        }
        throw new InvalidOperationException("自动发号繁忙，请稍后重试");
    }

    public static async Task<bool> TryReserveAsync(IMongoDatabase database, string key, string targetId)
    {
        var collection = database.GetCollection<BsonDocument>(CollectionName);
        try
        {
            var claim = await collection.FindOneAndUpdateAsync(
                Builders<BsonDocument>.Filter.Eq("_id", key),
                Builders<BsonDocument>.Update.SetOnInsert("targetId", targetId).SetOnInsert("createdAt", DateTime.UtcNow),
                new FindOneAndUpdateOptions<BsonDocument> { IsUpsert = true, ReturnDocument = ReturnDocument.After },
                CancellationToken.None);
            return claim != null && claim.GetValue("targetId", "").AsString == targetId;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return false;
        }
        catch (MongoCommandException ex) when (ex.Code == 11000)
        {
            return false;
        }
    }

    public static async Task<HashSet<string>> UsedReviewIdsAsync(MongoDbContext db)
    {
        var products = await db.ProductInitiations.Find(_ => true)
            .Project(x => new { x.ReviewSubmissionId, x.ReviewAttempts }).ToListAsync();
        var legacy = await db.VersionRegistrations.Find(x => x.ReviewSubmissionId != null)
            .Project(x => x.ReviewSubmissionId!).ToListAsync();
        var claims = await db.Database.GetCollection<BsonDocument>(CollectionName)
            .Find(Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression("^review:"))).ToListAsync();
        return products.SelectMany(x => new[] { x.ReviewSubmissionId }
                .Concat(x.ReviewAttempts?.Select(a => a.SubmissionId) ?? Enumerable.Empty<string?>()))
            .Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!)
            .Concat(legacy).Concat(claims.Select(x => x["_id"].AsString["review:".Length..])).ToHashSet();
    }

    public static async Task<bool> IsReviewUsedAsync(MongoDbContext db, string submissionId, string? excludedInitiationId = null)
    {
        var f = Builders<ProductInitiation>.Filter;
        var filter = f.Or(f.Eq(x => x.ReviewSubmissionId, submissionId),
            f.ElemMatch(x => x.ReviewAttempts, a => a.SubmissionId == submissionId));
        if (excludedInitiationId != null) filter &= f.Ne(x => x.Id, excludedInitiationId);
        if (await db.ProductInitiations.Find(filter).AnyAsync()
            || await db.VersionRegistrations.Find(x => x.ReviewSubmissionId == submissionId).AnyAsync()) return true;
        var claim = await db.Database.GetCollection<BsonDocument>(CollectionName)
            .Find(Builders<BsonDocument>.Filter.Eq("_id", ProductVersionClaimPolicy.ReviewKey(submissionId))).FirstOrDefaultAsync();
        return claim != null && (excludedInitiationId == null
            || claim.GetValue("targetId", "").AsString != "initiation:" + excludedInitiationId);
    }
}
