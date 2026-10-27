using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>正式版本与内部版本采用相同的全局发号先后规则，资格不受列表筛选影响。</summary>
public static class ProductReleaseDeletion
{
    public static async Task<string?> LatestIdAsync(MongoDbContext db)
    {
        var current = await db.ProductReleases.Find(x => !x.IsDeleted && x.VCode != "")
            .Project(x => new { x.Id, x.VCode, x.CreatedAt }).ToListAsync();
        var legacy = await db.VersionRegistrations.Find(x => x.Kind == VersionRegistrationKind.Formal)
            .Project(x => new { x.Code, x.CreatedAt }).ToListAsync();
        var claims = await db.Database.GetCollection<BsonDocument>(ProductVersionClaimGuard.CollectionName)
            .Find(Builders<BsonDocument>.Filter.Regex("_id", new BsonRegularExpression("^workflow-code:V:"))
                & Builders<BsonDocument>.Filter.In("targetId", current.Select(x => "release:" + x.Id))).ToListAsync();
        var times = claims.Where(x => x.Contains("createdAt") && x["createdAt"].IsBsonDateTime)
            .GroupBy(x => x["targetId"].AsString).ToDictionary(x => x.Key, x => x.Max(c => c["createdAt"].ToUniversalTime()));
        var latest = current.Where(x => Version.TryParse(x.VCode.Trim().TrimStart('V', 'v'), out _))
            .Select(x => (Id: (string?)x.Id, At: times.GetValueOrDefault("release:" + x.Id, x.CreatedAt)))
            .Concat(legacy.Where(x => Version.TryParse(x.Code.Trim().TrimStart('V', 'v'), out _))
                .Select(x => (Id: (string?)null, At: x.CreatedAt)))
            .OrderByDescending(x => x.At).Take(2).ToList();
        return latest.Count == 0 || (latest.Count > 1 && latest[0].At == latest[1].At) ? null : latest[0].Id;
    }

    public static async Task<bool> HasDownstreamAsync(MongoDbContext db, string id) =>
        await db.ProductReleases.Find(x => !x.IsDeleted && x.PreviousReleaseId == id).AnyAsync()
        || await db.Features.Find(x => !x.IsDeleted && x.OfficialReleaseId == id).AnyAsync()
        || await db.Requirements.Find(x => !x.IsDeleted && x.VersionIds.Contains(id)).AnyAsync();

    public static async Task AnnotateAsync(MongoDbContext db, IReadOnlyList<ProductRelease> items, string userId)
    {
        foreach (var item in items) item.CanDelete = false;
        if (items.Count == 0) return;
        var latestId = await LatestIdAsync(db);
        var latest = items.FirstOrDefault(x => x.Id == latestId);
        if (latest != null && latest.CreatedBy == userId && latest.ClaimNotification?.Status != "sending"
            && !await HasDownstreamAsync(db, latest.Id)) latest.CanDelete = true;
    }
}
