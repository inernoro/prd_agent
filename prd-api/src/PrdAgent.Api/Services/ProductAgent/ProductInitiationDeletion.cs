using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>列表、详情和删除共用全局资格，不从调用方已筛选的数据推断最新记录。</summary>
public static class ProductInitiationDeletion
{
    public static async Task<string?> LatestIdAsync(MongoDbContext db)
    {
        var current = await db.ProductInitiations.Find(x => !x.IsDeleted && x.TCode != null && x.TCode != "")
            .Project(x => new { x.Id, x.TCode }).ToListAsync();
        var legacy = await db.VersionRegistrations.Find(x => x.Kind == VersionRegistrationKind.Internal)
            .Project(x => x.Code).ToListAsync();
        // T 号全局递增；按数字比较而非更新时间，修改旧资料或重新导入不会改变序列位置。
        var numbered = current.Select(x => (Id: (string?)x.Id, Code: x.TCode))
            .Concat(legacy.Select(x => (Id: (string?)null, Code: (string?)x)))
            .Select(x => (x.Id, Number: Version.TryParse(x.Code?.Trim().TrimStart('T', 't'), out var n) ? n : null))
            .Where(x => x.Number != null).OrderByDescending(x => x.Number).Take(2).ToList();
        // 同号无法证明哪条最后，旧登记只读；均不向任意一条开放删除。
        return numbered.Count == 0 || (numbered.Count > 1 && numbered[0].Number == numbered[1].Number)
            ? null : numbered[0].Id;
    }

    public static async Task<bool> HasDownstreamAsync(MongoDbContext db, ProductInitiation item, string applicationName)
    {
        var history = await ProductVersionHistoryLinks.CheckAsync(db, item.ProductId, applicationName, item.TCode!, item.PlanName);
        return history.Blocked || history.NeedsConfirmation
            || await db.ProductReleases.Find(x => x.InitiationId == item.Id).AnyAsync()
            || await db.Requirements.Find(x => !x.IsDeleted && x.VersionIds.Contains(item.Id)).AnyAsync()
            || await db.Features.Find(x => !x.IsDeleted && x.PlannedVersionId == item.Id).AnyAsync();
    }

    public static async Task AnnotateAsync(MongoDbContext db, IReadOnlyList<ProductInitiation> items)
    {
        foreach (var item in items) item.CanDelete = false;
        if (items.Count == 0) return;
        var latestId = await LatestIdAsync(db);
        var latest = items.FirstOrDefault(x => x.Id == latestId);
        if (latest == null) return;
        var product = await db.Products.Find(x => x.Id == (latest.LinkedProductId ?? latest.ProductId)).FirstOrDefaultAsync();
        var name = latest.AppName ?? product?.Name ?? string.Empty;
        if (string.IsNullOrWhiteSpace(name) || await HasDownstreamAsync(db, latest, name)) return;
        var claims = db.Database.GetCollection<MongoDB.Bson.BsonDocument>(ProductVersionClaimGuard.CollectionName);
        var claim = await claims.Find(Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("_id",
                ProductVersionClaimPolicy.ReleaseKey(name, latest.TCode!)))
            .FirstOrDefaultAsync();
        latest.CanDelete = claim == null || claim.GetValue("targetId", "").AsString == "deleted-initiation:" + latest.Id;
    }
}
