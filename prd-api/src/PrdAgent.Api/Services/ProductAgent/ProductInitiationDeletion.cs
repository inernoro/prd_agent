using MongoDB.Driver;
using MongoDB.Bson;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>列表、详情和删除共用按应用计算的资格，不从调用方已筛选的数据推断最新记录。</summary>
public static class ProductInitiationDeletion
{
    public static async Task<string?> LatestIdAsync(MongoDbContext db, string? applicationId = null)
    {
        if (applicationId != null)
            return (await ProductVersionApplicationLatest.ReadAsync(db, VersionRegistrationKind.Internal)).GetValueOrDefault(applicationId);
        var current = await db.ProductInitiations.Find(x => !x.IsDeleted && x.TCode != null && x.TCode != "")
            .Project(x => new { x.Id, x.TCode, x.IssuedAt, x.CreatedAt }).ToListAsync();
        var legacy = await db.VersionRegistrations.Find(x => x.Kind == VersionRegistrationKind.Internal)
            .Project(x => new { x.Code, x.CreatedAt }).ToListAsync();
        // 不同应用的数字大小不能代表全局先后；旧记录优先读回其原永久占号时间。
        var targets = current.Select(x => "initiation:" + x.Id).ToList();
        var claims = await db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName)
            .Find(Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression("^workflow-code:T:"))
                & Builders<BsonDocument>.Filter.In("targetId", targets)).ToListAsync();
        var issuedTimes = claims.Where(x => x.Contains("createdAt") && x["createdAt"].IsBsonDateTime)
            .GroupBy(x => x["targetId"].AsString).ToDictionary(x => x.Key, x => x.Max(c => c["createdAt"].ToUniversalTime()));
        var numbered = current.Where(x => Version.TryParse(x.TCode?.Trim().TrimStart('T', 't'), out _))
            .Select(x => (Id: (string?)x.Id, At: x.IssuedAt ?? issuedTimes.GetValueOrDefault("initiation:" + x.Id, x.CreatedAt)))
            .Concat(legacy.Where(x => Version.TryParse(x.Code.Trim().TrimStart('T', 't'), out _))
                .Select(x => (Id: (string?)null, At: x.CreatedAt)))
            .OrderByDescending(x => x.At).Take(2).ToList();
        // 时间相同不能证明唯一最新；普通资料UpdatedAt永不参与。
        return numbered.Count == 0 || (numbered.Count > 1 && numbered[0].At == numbered[1].At)
            ? null : numbered[0].Id;
    }

    public static async Task<bool> HasDownstreamAsync(MongoDbContext db, ProductInitiation item, string applicationName)
    {
        var history = await ProductVersionHistoryLinks.CheckAsync(db, item.ProductId, applicationName, item.TCode!, item.PlanName);
        return history.Blocked || history.NeedsConfirmation
            || await db.ProductReleases.Find(x => !x.IsDeleted && x.InitiationId == item.Id).AnyAsync()
            || await db.Requirements.Find(x => !x.IsDeleted && x.VersionIds.Contains(item.Id)).AnyAsync()
            || await db.Features.Find(x => !x.IsDeleted && x.PlannedVersionId == item.Id).AnyAsync();
    }

    public static async Task AnnotateAsync(MongoDbContext db, IReadOnlyList<ProductInitiation> items, string? userId = null)
    {
        foreach (var item in items) { item.CanDelete = false; item.CanChangeVersionType = false; }
        if (items.Count == 0) return;
        var latestIds = await ProductVersionApplicationLatest.ReadAsync(db, VersionRegistrationKind.Internal);
        var changeTypeLatest = await LatestIdAsync(db);
        foreach (var latest in items.Where(x => latestIds.GetValueOrDefault(ProductVersionApplicationLatest.Application(x)) == x.Id))
        {
            var product = await db.Products.Find(x => x.Id == (latest.LinkedProductId ?? latest.ProductId)).FirstOrDefaultAsync();
            var name = latest.AppName ?? product?.Name ?? string.Empty;
            if (string.IsNullOrWhiteSpace(name) || await HasDownstreamAsync(db, latest, name)) continue;
            var claims = db.Database.GetCollection<MongoDB.Bson.BsonDocument>(ProductVersionClaimGuard.CollectionName);
            var claim = await claims.Find(Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("_id",
                    ProductVersionClaimPolicy.ReleaseKey(name, latest.TCode!)))
                .FirstOrDefaultAsync();
            latest.CanDelete = claim == null || claim.GetValue("targetId", "").AsString == "deleted-initiation:" + latest.Id;
            latest.CanChangeVersionType = latest.Id == changeTypeLatest && latest.Status != "voided"
                && (latest.CanDelete || (claim != null && claim.GetValue("targetId", "").AsString
                .StartsWith("reissue-initiation:" + latest.Id + ":", StringComparison.Ordinal)));
            latest.CanDelete = latest.CanDelete && (userId == null || latest.CreatedBy == userId);
        }
    }
}
