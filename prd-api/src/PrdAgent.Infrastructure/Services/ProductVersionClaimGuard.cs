using MongoDB.Bson;
using MongoDB.Driver;
using System.Security.Cryptography;
using System.Text;
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

    /// <summary>先筛选对应应用，再按其T/V数字最大值升级；占号按稳定产品ID隔离。</summary>
    public static async Task<string> ReserveWorkflowCodeAsync(MongoDbContext db, string prefix, string versionType,
        string targetId, string applicationProductId)
    {
        if (prefix is not ("T" or "V")) throw new ArgumentException("不支持的版本编号类型", nameof(prefix));
        if (string.IsNullOrWhiteSpace(applicationProductId)) throw new ArgumentException("请选择所属应用", nameof(applicationProductId));
        var application = await db.Products.Find(x => x.Id == applicationProductId && !x.IsDeleted).FirstOrDefaultAsync()
            ?? throw new InvalidOperationException("所属应用不存在，请重新选择后申领");
        var keyPrefix = "workflow-code:" + prefix + ":"
            + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(applicationProductId))).ToLowerInvariant() + ":";
        var claims = db.Database.GetCollection<BsonDocument>(CollectionName);
        var codeClaims = Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression("^" + keyPrefix));
        // 只兼容旧的无应用占号；能由原目标归属到当前应用才计入，不能把其它应用的号带过来。
        var oldKeyPrefix = "workflow-code:" + prefix + ":";
        var oldClaims = Builders<BsonDocument>.Filter.Regex("_id",
            new BsonRegularExpression("^" + oldKeyPrefix + prefix + "[0-9]+\\.[0-9]+\\.[0-9]+$"));
        var reserved = await claims.Find(codeClaims & Builders<BsonDocument>.Filter.Eq("targetId", targetId)).FirstOrDefaultAsync();
        if (reserved != null) return reserved["_id"].AsString[keyPrefix.Length..];
        var oldReserved = await claims.Find(oldClaims & Builders<BsonDocument>.Filter.Eq("targetId", targetId)).FirstOrDefaultAsync();
        if (oldReserved != null) return oldReserved["_id"].AsString[oldKeyPrefix.Length..];
        var normalizedName = VersionRegistryCatalog.NormalizeName(application.Name);
        var productNames = await db.Products.Find(x => !x.IsDeleted).Project(x => x.Name).ToListAsync();
        // 与全域表的旧登记归属一致：应用名称必须唯一匹配，重名不猜测归属。
        var uniqueName = productNames.Count(x => VersionRegistryCatalog.NormalizeName(x) == normalizedName) == 1;
        var legacyFilter = Builders<VersionRegistration>.Filter.Eq(x => x.Kind,
            prefix == "T" ? VersionRegistrationKind.Internal : VersionRegistrationKind.Formal);
        var legacy = uniqueName ? (await db.VersionRegistrations.Find(legacyFilter).ToListAsync())
            .Where(x => VersionRegistryCatalog.NormalizeName(x.ApplicationName) == normalizedName).Select(x => x.Code).ToList() : new List<string>();
        for (var attempt = 0; attempt < 64; attempt++)
        {
            // ProductId是导入映射；新立项优先使用明确选择的LinkedProductId。已删除同应用编号仍不可回收。
            var candidates = await db.ProductInitiations.Find(x => x.LinkedProductId == applicationProductId
                || x.ProductId == applicationProductId).ToListAsync();
            var initiations = candidates.Where(x => (string.IsNullOrWhiteSpace(x.LinkedProductId) ? x.ProductId : x.LinkedProductId) == applicationProductId).ToList();
            var initiationIds = initiations.Select(x => x.Id).ToList();
            var foreignInitiationIds = candidates.Where(x => !initiationIds.Contains(x.Id)).Select(x => x.Id).ToList();
            var releases = prefix == "V" ? await db.ProductReleases.Find(x => x.ProductId == applicationProductId
                && (x.InitiationId == null || !foreignInitiationIds.Contains(x.InitiationId))
                || (x.InitiationId != null && initiationIds.Contains(x.InitiationId))).ToListAsync() : new List<ProductRelease>();
            var existing = prefix == "T"
                ? initiations.Where(x => x.TCode != null).Select(x => x.TCode!).ToList()
                : releases.Select(x => x.VCode).ToList();
            var ownTargets = prefix == "T" ? initiations.Select(x => "initiation:" + x.Id).ToList()
                : releases.Select(x => "release:" + x.Id).ToList();
            var oldAllocations = await claims.Find(oldClaims & Builders<BsonDocument>.Filter.In("targetId", ownTargets)).ToListAsync();
            var allocations = await claims.Find(codeClaims).ToListAsync();
            var candidate = ProductEntityNumbering.NextWorkflowCode(prefix, versionType,
                existing.Concat(legacy).Concat(oldAllocations.Select(x => x["_id"].AsString[oldKeyPrefix.Length..]))
                    .Concat(allocations.Select(x => x["_id"].AsString[keyPrefix.Length..])));
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
