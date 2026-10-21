using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ProductAgent;

// Read DTOs only: legacy rows are never written into the product workflow collections.
public sealed record ProductVersionListRow<T>(T Record, VersionRegistration? LegacyRegistration = null);
public sealed record ProductVersionListResult<T>(
    List<ProductVersionListRow<T>> Items, Dictionary<string, string> RequirementNames);

/// <summary>Global version lists, including authorized legacy registrations, without reading audit snapshots.</summary>
public static class ProductVersionListReader
{
    private static async Task<List<Product>> ReadProductsAsync(MongoDbContext db, HashSet<string>? scope)
    {
        var filter = Builders<Product>.Filter.Eq(x => x.IsDeleted, false);
        if (scope != null) filter &= Builders<Product>.Filter.In(x => x.Id, scope);
        return await db.Products.Find(filter).ToListAsync();
    }

    private static async Task<List<VersionRegistration>> ReadLegacyAsync(
        MongoDbContext db, string kind, string userId, bool canViewAllLegacy)
    {
        var filter = Builders<VersionRegistration>.Filter.Eq(x => x.Kind, kind);
        // Keep the same ACL as the existing legacy list and copy-template endpoint.
        if (!canViewAllLegacy) filter &= Builders<VersionRegistration>.Filter.Eq(x => x.CreatedBy, userId);
        return await db.VersionRegistrations.Find(filter).SortByDescending(x => x.UpdatedAt).ToListAsync();
    }

    public static async Task<ProductVersionListResult<ProductInitiation>> ReadInitiationsAsync(
        MongoDbContext db, HashSet<string>? scope, string userId, bool canViewAllLegacy)
    {
        var products = await ReadProductsAsync(db, scope);
        var ids = products.Select(x => x.Id).ToList();
        var current = await db.ProductInitiations.Find(
            Builders<ProductInitiation>.Filter.Eq(x => x.IsDeleted, false)
            & Builders<ProductInitiation>.Filter.In(x => x.ProductId, ids)).ToListAsync();
        var legacy = await ReadLegacyAsync(db, VersionRegistrationKind.Internal, userId, canViewAllLegacy);
        await ProductInitiationDeletion.AnnotateAsync(db, current);
        return new(MergeInitiations(current, legacy, products), new());
    }

    public static async Task<ProductVersionListResult<ProductRelease>> ReadReleasesAsync(
        MongoDbContext db, HashSet<string>? scope, string userId, bool canViewAllLegacy)
    {
        var products = await ReadProductsAsync(db, scope);
        var ids = products.Select(x => x.Id).ToList();
        var current = await db.ProductReleases.Find(
            Builders<ProductRelease>.Filter.Eq(x => x.IsDeleted, false)
            & Builders<ProductRelease>.Filter.In(x => x.ProductId, ids)).ToListAsync();
        var legacy = await ReadLegacyAsync(db, VersionRegistrationKind.Formal, userId, canViewAllLegacy);
        var requirementIds = current.SelectMany(x => x.RequirementIds).Distinct().ToList();
        var names = new Dictionary<string, string>();
        if (requirementIds.Count > 0)
        {
            var requirements = await db.Requirements.Find(
                Builders<Requirement>.Filter.In(x => x.Id, requirementIds))
                .Project(x => new { x.Id, x.Title }).ToListAsync();
            foreach (var item in requirements) names[item.Id] = item.Title;
        }
        return new(MergeReleases(current, legacy, products), names);
    }

    private static string ResolveProductId(VersionRegistration record, IReadOnlyList<Product> products)
    {
        var name = VersionRegistryCatalog.NormalizeName(record.ApplicationName);
        if (name.Length == 0) return string.Empty;
        var matches = products.Where(x => VersionRegistryCatalog.NormalizeName(x.Name) == name).Take(2).ToList();
        return matches.Count == 1 ? matches[0].Id : string.Empty;
    }

    private static string Key(string productId, string? appName, string? code, string id)
    {
        if (string.IsNullOrWhiteSpace(code)) return $"record:{id}";
        var application = !string.IsNullOrWhiteSpace(productId) ? $"product:{productId}"
            : $"app:{VersionRegistryCatalog.NormalizeName(appName)}";
        // Missing application metadata cannot prove two records refer to the same business version.
        if (application == "app:") return $"record:{id}";
        return $"{application}:{code.Trim().ToUpperInvariant()}";
    }

    public static List<ProductVersionListRow<ProductInitiation>> MergeInitiations(
        IReadOnlyList<ProductInitiation> current, IReadOnlyList<VersionRegistration> legacy, IReadOnlyList<Product> products)
    {
        var rows = current.Select(x => new ProductVersionListRow<ProductInitiation>(x)).ToList();
        var seen = current.Select(x => Key(x.ProductId, x.AppName, x.TCode, x.Id)).ToHashSet();
        foreach (var old in legacy.OrderByDescending(x => x.UpdatedAt))
        {
            var productId = ResolveProductId(old, products);
            var id = $"legacy:{old.Id}";
            if (!seen.Add(Key(productId, old.ApplicationName, old.Code, id))) continue;
            var record = new ProductInitiation
            {
                Id = id, ProductId = productId, TCode = old.Code, SystemName = old.SystemName,
                AppName = old.ApplicationName, ProjectType = old.ProjectType, VersionType = old.VersionType,
                PlanName = old.PlanName ?? string.Empty, PlanUrl = old.PlanUrl, DemandSource = old.DemandSource,
                RequirementDescription = old.RequirementDescription, DepartmentName = old.DepartmentName,
                OwnerName = old.OwnerName ?? old.CreatedByName, ProjectMemberNames = old.ProjectMemberNames,
                PlannedProjectAt = old.PlannedProjectAt, NeedUiDesign = old.NeedUiDesign, IsAiPoc = old.IsAiPoc,
                DevelopmentStatus = old.DevelopmentStatus ?? string.Empty, Remark = old.Remark,
                Status = "legacy_readonly", SourceType = "import", CreatedBy = old.CreatedBy,
                CreatedAt = old.CreatedAt, UpdatedAt = old.UpdatedAt,
            };
            rows.Add(new(record, old));
        }
        return rows.OrderByDescending(x => x.Record.UpdatedAt).ToList();
    }

    public static List<ProductVersionListRow<ProductRelease>> MergeReleases(
        IReadOnlyList<ProductRelease> current, IReadOnlyList<VersionRegistration> legacy, IReadOnlyList<Product> products)
    {
        var rows = current.Select(x => new ProductVersionListRow<ProductRelease>(x)).ToList();
        var seen = current.Select(x => Key(x.ProductId, x.AppName, x.VCode, x.Id)).ToHashSet();
        foreach (var old in legacy.OrderByDescending(x => x.UpdatedAt))
        {
            var productId = ResolveProductId(old, products);
            var id = $"legacy:{old.Id}";
            if (!seen.Add(Key(productId, old.ApplicationName, old.Code, id))) continue;
            var record = new ProductRelease
            {
                Id = id, ProductId = productId, VCode = old.Code, TCode = old.TCode,
                SystemName = old.SystemName, AppName = old.ApplicationName, ProjectType = old.ProjectType,
                VersionType = old.VersionType, PlanName = old.PlanName ?? string.Empty, PlanUrl = old.PlanUrl,
                DepartmentName = old.DepartmentName, DemandSource = old.DemandSource,
                RequirementDescription = old.RequirementDescription, OwnerName = old.OwnerName ?? old.CreatedByName,
                ProjectMemberNames = old.ProjectMemberNames, ContractParty = old.ContractParty, Remark = old.Remark,
                IsGlobalOpen = old.IsGlobalOpen, OpenBrandScope = old.IsGlobalOpen == true ? "上线全域开放" : string.Empty,
                PlannedReleaseAt = old.PlannedReleaseAt, PlannedTrainingMinutes = old.PlannedTrainingMinutes,
                Status = "legacy_readonly", SourceType = "import", CreatedBy = old.CreatedBy,
                CreatedAt = old.CreatedAt, UpdatedAt = old.UpdatedAt,
            };
            rows.Add(new(record, old));
        }
        return rows.OrderByDescending(x => x.Record.UpdatedAt).ToList();
    }
}
