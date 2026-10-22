using MongoDB.Bson;
using MongoDB.Driver;
using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 依靠 MongoDB 原生 _id 唯一性占用来源及编号，跨实例和新旧入口共用。
/// 编号永久保留；业务来源只在目标已确认移除时释放，未知结果与在途请求不能重占。
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
            // 只读当前全局业务表；原数字编号的独立占号记录防止回收。
            var candidates = await db.ProductInitiations.Find(x => !x.IsDeleted && (x.LinkedProductId == applicationProductId
                || x.ProductId == applicationProductId)).ToListAsync();
            var initiations = candidates.Where(x => (string.IsNullOrWhiteSpace(x.LinkedProductId) ? x.ProductId : x.LinkedProductId) == applicationProductId).ToList();
            var initiationIds = initiations.Select(x => x.Id).ToList();
            var foreignInitiationIds = candidates.Where(x => !initiationIds.Contains(x.Id)).Select(x => x.Id).ToList();
            var releases = prefix == "V" ? await db.ProductReleases.Find(x => !x.IsDeleted && (x.ProductId == applicationProductId
                && (x.InitiationId == null || !foreignInitiationIds.Contains(x.InitiationId))
                || (x.InitiationId != null && initiationIds.Contains(x.InitiationId)))).ToListAsync() : new List<ProductRelease>();
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

    public static async Task<bool> TryReserveSourceAsync(MongoDbContext db, string key, string targetId)
    {
        if (!key.StartsWith("review:", StringComparison.Ordinal) && !key.StartsWith("release:", StringComparison.Ordinal))
            throw new ArgumentException("这里只能预留业务来源，不能释放编号占用", nameof(key));
        var claims = db.Database.GetCollection<BsonDocument>(CollectionName);
        if (await IsDeletedTargetAsync(db, targetId)) return false;
        var claim = await claims.Find(Builders<BsonDocument>.Filter.Eq("_id", key)).FirstOrDefaultAsync();
        if (claim != null && await IsDeletedTargetAsync(db, claim.GetValue("targetId", "").AsString))
        {
            await ReleaseDeletedSourceClaimsAsync(db, claim.GetValue("targetId", "").AsString);
            await claims.DeleteOneAsync(Builders<BsonDocument>.Filter.Eq("_id", key)
                & Builders<BsonDocument>.Filter.Eq("targetId", claim["targetId"]), CancellationToken.None);
        }
        return await TryReserveAsync(db.Database, key, targetId);
    }

    private static async Task<bool> IsDeletedTargetAsync(MongoDbContext db, string target)
    {
        bool exists;
        if (target.StartsWith("initiation:", StringComparison.Ordinal))
        {
            var id = target.Substring("initiation:".Length);
            if (await db.ProductInitiations.Find(x => x.Id == id && x.IsDeleted).AnyAsync()) return true;
            exists = await db.ProductInitiations.Find(x => x.Id == id).AnyAsync();
        }
        else if (target.StartsWith("release:", StringComparison.Ordinal))
        {
            var id = target.Substring("release:".Length);
            if (await db.ProductReleases.Find(x => x.Id == id && x.IsDeleted).AnyAsync()) return true;
            exists = await db.ProductReleases.Find(x => x.Id == id).AnyAsync();
        }
        else return false;
        // 只保留最小删除凭证，不保留业务记录；未知在途目标不能因尚未写入而被抢占。
        return !exists && await db.Database.GetCollection<BsonDocument>(CollectionName)
            .Find(Builders<BsonDocument>.Filter.Eq("_id", "source-removed:" + target)).AnyAsync();
    }

    public static Task<bool> MarkSourceRemovalAsync(MongoDbContext db, string targetId) =>
        TryReserveAsync(db.Database, "source-removed:" + targetId, targetId);

    public static async Task ReleaseDeletedSourceClaimsAsync(MongoDbContext db, string targetId)
    {
        if (!await IsDeletedTargetAsync(db, targetId)) return;
        await MarkSourceRemovalAsync(db, targetId);
        // 兼容清除上线前已标记删除的残留，绝不把它们继续作为正常业务记录读取。
        if (targetId.StartsWith("initiation:", StringComparison.Ordinal))
            await db.ProductInitiations.DeleteOneAsync(x => x.Id == targetId.Substring("initiation:".Length) && x.IsDeleted, CancellationToken.None);
        else if (targetId.StartsWith("release:", StringComparison.Ordinal))
            await db.ProductReleases.DeleteOneAsync(x => x.Id == targetId.Substring("release:".Length) && x.IsDeleted, CancellationToken.None);
        var prefix = targetId.StartsWith("initiation:", StringComparison.Ordinal) ? "^review:" : "^release:";
        await db.Database.GetCollection<BsonDocument>(CollectionName).DeleteManyAsync(
            Builders<BsonDocument>.Filter.Eq("targetId", targetId)
            & Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression(prefix)), CancellationToken.None);
    }

    public static async Task ReleaseDeletedSourceClaimsForKindAsync(MongoDbContext db, string kind)
    {
        var prefix = kind == "internal" ? "^review:" : "^release:";
        var targetPrefix = kind == "internal" ? "initiation:" : "release:";
        var claims = await db.Database.GetCollection<BsonDocument>(CollectionName)
            .Find(Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression(prefix))
                & Builders<BsonDocument>.Filter.Regex("targetId", new BsonRegularExpression("^" + targetPrefix))).ToListAsync();
        foreach (var target in claims.Select(x => x["targetId"].AsString).Distinct())
            await ReleaseDeletedSourceClaimsAsync(db, target);
    }

    public static async Task<HashSet<string>> UsedReviewIdsAsync(MongoDbContext db)
    {
        var products = await db.ProductInitiations.Find(x => !x.IsDeleted)
            .Project(x => new { x.ReviewSubmissionId, x.ReviewAttempts }).ToListAsync();
        var legacy = await db.VersionRegistrations.Find(x => x.ReviewSubmissionId != null)
            .Project(x => x.ReviewSubmissionId!).ToListAsync();
        var claims = await db.Database.GetCollection<BsonDocument>(CollectionName)
            .Find(Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression("^review:"))).ToListAsync();
        var occupiedClaims = new List<string>();
        foreach (var claim in claims)
            if (!await IsDeletedTargetAsync(db, claim.GetValue("targetId", "").AsString))
                occupiedClaims.Add(claim["_id"].AsString["review:".Length..]);
        return products.SelectMany(x => new[] { x.ReviewSubmissionId }
                .Concat(x.ReviewAttempts?.Select(a => a.SubmissionId) ?? Enumerable.Empty<string?>()))
            .Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!)
            .Concat(legacy).Concat(occupiedClaims).ToHashSet();
    }

    public static async Task<bool> IsReviewUsedAsync(MongoDbContext db, string submissionId, string? excludedInitiationId = null)
    {
        var f = Builders<ProductInitiation>.Filter;
        var filter = f.Eq(x => x.IsDeleted, false) & f.Or(f.Eq(x => x.ReviewSubmissionId, submissionId),
            f.ElemMatch(x => x.ReviewAttempts, a => a.SubmissionId == submissionId));
        if (excludedInitiationId != null) filter &= f.Ne(x => x.Id, excludedInitiationId);
        if (await db.ProductInitiations.Find(filter).AnyAsync()
            || await db.VersionRegistrations.Find(x => x.ReviewSubmissionId == submissionId).AnyAsync()) return true;
        var claim = await db.Database.GetCollection<BsonDocument>(CollectionName)
            .Find(Builders<BsonDocument>.Filter.Eq("_id", ProductVersionClaimPolicy.ReviewKey(submissionId))).FirstOrDefaultAsync();
        return claim != null && (excludedInitiationId == null
            || claim.GetValue("targetId", "").AsString != "initiation:" + excludedInitiationId)
            && !await IsDeletedTargetAsync(db, claim.GetValue("targetId", "").AsString);
    }
}
