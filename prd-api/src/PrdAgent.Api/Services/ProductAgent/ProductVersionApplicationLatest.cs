using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>删除资格按应用实际编号判断；作废记录仍保留编号，资料修改时间不改变资格。</summary>
public static class ProductVersionApplicationLatest
{
    public static string Application(ProductInitiation item) =>
        string.IsNullOrWhiteSpace(item.LinkedProductId) ? item.ProductId : item.LinkedProductId;

    public static async Task<Dictionary<string, string?>> ReadAsync(MongoDbContext db, string kind)
    {
        var products = await db.Products.Find(x => !x.IsDeleted).Project(x => new { x.Id, x.Name }).ToListAsync();
        var names = products.GroupBy(x => VersionRegistryCatalog.NormalizeName(x.Name)).ToList();
        var unique = names.Where(x => x.Count() == 1).ToDictionary(x => x.Key, x => x.Single().Id);
        var initiations = await db.ProductInitiations.Find(_ => true).ToListAsync();
        var sources = initiations.ToDictionary(x => x.Id, Application);
        var rows = new List<(string App, string? Id, Version Code)>();
        void Add(string app, string? id, string? code)
        {
            if (!string.IsNullOrWhiteSpace(app) && Version.TryParse(code?.Trim().TrimStart('T', 't', 'V', 'v'), out var parsed))
                rows.Add((app, id, parsed));
        }
        if (kind == VersionRegistrationKind.Internal)
            foreach (var item in initiations.Where(x => !x.IsDeleted)) Add(Application(item), item.Id, item.TCode);
        else
            foreach (var item in await db.ProductReleases.Find(x => !x.IsDeleted).ToListAsync())
                Add(item.InitiationId != null && sources.TryGetValue(item.InitiationId, out var app) ? app : item.ProductId, item.Id, item.VCode);
        var legacy = await db.VersionRegistrations.Find(x => x.Kind == kind).ToListAsync();
        var ambiguous = new HashSet<string>();
        foreach (var item in legacy)
        {
            var name = VersionRegistryCatalog.NormalizeName(item.ApplicationName);
            if (unique.TryGetValue(name, out var app)) Add(app, null, item.Code);
            else foreach (var product in products.Where(x => VersionRegistryCatalog.NormalizeName(x.Name) == name)) ambiguous.Add(product.Id);
        }
        var result = new Dictionary<string, string?>();
        foreach (var group in rows.GroupBy(x => x.App))
        {
            var latest = group.OrderByDescending(x => x.Code).Take(2).ToList();
            result[group.Key] = ambiguous.Contains(group.Key) || (latest.Count > 1 && latest[0].Code == latest[1].Code)
                ? null : latest[0].Id;
        }
        return result;
    }
}
