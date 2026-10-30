using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ProductAgent;

public static class ProductReleaseTrainingPolicy
{
    public static bool IsRequired(string? application) => VersionRegistryCatalog.NormalizeName(application) != "米多总后台";

    public static async Task AnnotateAsync(MongoDbContext db, IEnumerable<ProductInitiation> source)
    {
        var items = source.ToList();
        var missing = items.Where(x => string.IsNullOrWhiteSpace(x.AppName)).Select(x => x.ProductId).Distinct().ToList();
        var names = missing.Count == 0 ? new Dictionary<string, string>()
            : (await db.Products.Find(Builders<Product>.Filter.In(x => x.Id, missing)).ToListAsync()).ToDictionary(x => x.Id, x => x.Name);
        foreach (var item in items)
            item.ReleaseTrainingRequired = IsRequired(string.IsNullOrWhiteSpace(item.AppName) ? names.GetValueOrDefault(item.ProductId) : item.AppName);
    }
}
