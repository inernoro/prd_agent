using MongoDB.Bson;
using MongoDB.Driver;
using System.Text;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 评审/立项来源的唯一性与历史删除回执；号码只从有效业务记录计算，应用租约负责串行写入。
/// </summary>
public static class ProductVersionClaimGuard
{
    public const string CollectionName = "product_version_claims";

    /// <summary>持有应用租约后读取有效记录发号，不读取或新增独立数字占号。</summary>
    public static async Task<string> NextWorkflowCodeAsync(MongoDbContext db, string prefix, string versionType,
        string targetId, string applicationProductId, ProductVersionApplicationLease lease)
    {
        if (prefix is not ("T" or "V")) throw new ArgumentException("不支持的版本编号类型", nameof(prefix));
        if (string.IsNullOrWhiteSpace(applicationProductId)) throw new ArgumentException("请选择所属应用", nameof(applicationProductId));
        if (!lease.Covers(applicationProductId)) throw new InvalidOperationException("请先取得所属应用的申领队列再发号");
        await lease.EnsureHeldAsync();
        if (await IsDeletedTargetAsync(db, targetId))
            throw new InvalidOperationException("申领记录已删除，请刷新后重新申领");
        var application = await db.Products.Find(x => x.Id == applicationProductId && !x.IsDeleted).FirstOrDefaultAsync()
            ?? throw new InvalidOperationException("所属应用不存在，请重新选择后申领");
        var normalizedName = VersionRegistryCatalog.NormalizeName(application.Name);
        var productNames = await db.Products.Find(x => !x.IsDeleted).Project(x => x.Name).ToListAsync();
        // 与全域表的旧登记归属一致：应用名称必须唯一匹配，重名不猜测归属。
        var uniqueName = productNames.Count(x => VersionRegistryCatalog.NormalizeName(x) == normalizedName) == 1;
        var legacyFilter = Builders<VersionRegistration>.Filter.Eq(x => x.Kind,
            prefix == "T" ? VersionRegistrationKind.Internal : VersionRegistrationKind.Formal);
        var legacy = uniqueName ? (await db.VersionRegistrations.Find(legacyFilter).ToListAsync())
            .Where(x => VersionRegistryCatalog.NormalizeName(x.ApplicationName) == normalizedName).Select(x => x.Code).ToList() : new List<string>();
        if (prefix == "T" && uniqueName)
            legacy.AddRange((await db.VersionRegistrations.Find(x => x.Kind == VersionRegistrationKind.Formal).ToListAsync())
                .Where(x => VersionRegistryCatalog.NormalizeName(x.ApplicationName) == normalizedName && !string.IsNullOrWhiteSpace(x.TCode))
                .Select(x => x.TCode!));
        // 号码唯一业务依据是当前有效记录；历史占号和删除回执都不参与基准。
        var candidates = await db.ProductInitiations.Find(x => !x.IsDeleted && (x.LinkedProductId == applicationProductId
                || x.ProductId == applicationProductId)).ToListAsync();
        var initiations = candidates.Where(x => (string.IsNullOrWhiteSpace(x.LinkedProductId) ? x.ProductId : x.LinkedProductId) == applicationProductId).ToList();
        var initiationIds = initiations.Select(x => x.Id).ToList();
        var foreignInitiationIds = candidates.Where(x => !initiationIds.Contains(x.Id)).Select(x => x.Id).ToList();
        var releases = await db.ProductReleases.Find(x => !x.IsDeleted && (x.ProductId == applicationProductId
            && (x.InitiationId == null || !foreignInitiationIds.Contains(x.InitiationId))
            || (x.InitiationId != null && initiationIds.Contains(x.InitiationId)))).ToListAsync();
        var existing = prefix == "T"
            // 调试清空T但保留V时，仍有效的V引用的T号也不能重发给另一份方案。
            ? initiations.Where(x => x.TCode != null).Select(x => x.TCode!)
                .Concat(releases.Where(x => !string.IsNullOrWhiteSpace(x.TCode)).Select(x => x.TCode!)).ToList()
            : releases.Select(x => x.VCode).ToList();
        return ProductEntityNumbering.NextWorkflowCode(prefix, versionType, existing.Concat(legacy));
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
            throw new ArgumentException("这里只能预留评审或立项来源", nameof(key));
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

    private static string RemovalTarget(string target)
    {
        if (target.StartsWith("deleted-initiation:", StringComparison.Ordinal))
            return "initiation:" + target["deleted-initiation:".Length..];
        if (target.StartsWith("reissue-initiation:", StringComparison.Ordinal))
            return "initiation:" + target["reissue-initiation:".Length..].Split(':', 2)[0];
        return target.StartsWith("initiation:", StringComparison.Ordinal)
            ? target.Split(":revision:", 2, StringSplitOptions.None)[0] : target;
    }

    private static async Task<bool> IsDeletedTargetAsync(MongoDbContext db, string target)
    {
        target = RemovalTarget(target);
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

    public static string? NormalizeRemovalReason(string? value)
    {
        var reason = value?.Trim();
        return reason != null && reason.EnumerateRunes().Count() > 5 ? reason : null;
    }

    public static async Task<bool> MarkSourceRemovalAsync(MongoDbContext db, string targetId,
        string? reason = null, string? requestedBy = null)
    {
        var key = "source-removed:" + targetId;
        if (reason != null && (NormalizeRemovalReason(reason) == null || string.IsNullOrWhiteSpace(requestedBy)))
            throw new ArgumentException("作废理由至少填写6个字符，并记录操作人");
        if (!await TryReserveAsync(db.Database, key, targetId)) return false;
        // 删除前保存理由；记录仍存在时凭证不代表已作废，不携带号码或参与发号。
        if (reason != null)
        {
            var saved = await db.Database.GetCollection<BsonDocument>(CollectionName).UpdateOneAsync(
                Builders<BsonDocument>.Filter.Eq("_id", key) & Builders<BsonDocument>.Filter.Eq("targetId", targetId),
                Builders<BsonDocument>.Update.Set("reason", reason.Trim()).Set("requestedBy", requestedBy)
                    .Set("requestedAt", DateTime.UtcNow), cancellationToken: CancellationToken.None);
            return saved.MatchedCount == 1;
        }
        return true;
    }

    public static async Task ReleaseDeletedSourceClaimsAsync(MongoDbContext db, string targetId)
    {
        targetId = RemovalTarget(targetId);
        if (!await IsDeletedTargetAsync(db, targetId)) return;
        await MarkSourceRemovalAsync(db, targetId);
        // 兼容清除上线前已标记删除的残留，绝不把它们继续作为正常业务记录读取。
        if (targetId.StartsWith("initiation:", StringComparison.Ordinal))
            await db.ProductInitiations.DeleteOneAsync(x => x.Id == targetId.Substring("initiation:".Length) && x.IsDeleted, CancellationToken.None);
        else if (targetId.StartsWith("release:", StringComparison.Ordinal))
            await db.ProductReleases.DeleteOneAsync(x => x.Id == targetId.Substring("release:".Length) && x.IsDeleted, CancellationToken.None);
        var f = Builders<BsonDocument>.Filter;
        var targets = f.Eq("targetId", targetId);
        var initiation = targetId.StartsWith("initiation:", StringComparison.Ordinal);
        if (initiation)
        {
            var id = targetId["initiation:".Length..];
            targets |= f.Regex("targetId", new BsonRegularExpression("^" + System.Text.RegularExpressions.Regex.Escape(targetId) + ":revision:"))
                | f.Eq("targetId", "deleted-initiation:" + id)
                | f.Regex("targetId", new BsonRegularExpression("^reissue-initiation:" + System.Text.RegularExpressions.Regex.Escape(id) + ":"));
        }
        // 精确限定旧目标，编号若已由新请求取得，不会被迟到的清理删除。
        await db.Database.GetCollection<BsonDocument>(CollectionName).DeleteManyAsync(targets
            & f.Regex("_id", new BsonRegularExpression(initiation ? "^(review:|release:|workflow-code:T:)" : "^(release:|workflow-code:V:)")), CancellationToken.None);
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
