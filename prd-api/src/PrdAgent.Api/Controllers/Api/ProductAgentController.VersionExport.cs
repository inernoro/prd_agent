using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using MongoDB.Driver;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class ProductAgentController
{
    private sealed record VersionExportSource(string ProductId, string? ApplicationName, string? SystemName,
        string? OwnerId, string? OwnerName, IReadOnlyList<string> MemberIds, IReadOnlyList<string> MemberNames);

    private sealed record ReleaseTableOrigin(string Id, string? TCode, string? InitiationId, string? PreviousReleaseId,
        bool IsManualTCode, string? StatusBeforeVoid, string? VoidedBy, string CreatedBy, string SourceType,
        DateTime CreatedAt, DateTime UpdatedAt);

    private IDataProtector ReleaseTableProtector(string productId, string versionKey) =>
        HttpContext.RequestServices.GetRequiredService<IDataProtectionProvider>().CreateProtector(
            "map-release-table-v1", _db.Database.DatabaseNamespace.DatabaseName, productId, versionKey);

    private static string ReleaseTableKey(bool temporary, string code, string planName) =>
        temporary ? "temporary:" + planName.Trim() : "release:" + code.Trim().ToUpperInvariant();

    private string ProtectReleaseTableOrigin(ProductRelease release) =>
        ReleaseTableProtector(release.ProductId, ReleaseTableKey(release.IsTemporaryOptimization, release.VCode, release.PlanName))
            .Protect(JsonSerializer.Serialize(new ReleaseTableOrigin(release.Id, release.TCode, release.InitiationId,
                release.PreviousReleaseId, release.IsManualTCode, release.StatusBeforeVoid, release.VoidedBy, release.CreatedBy,
                release.SourceType, release.CreatedAt, release.UpdatedAt)));

    private async Task<Func<string?, string?>> ResolveVersionPersonKeysAsync(IEnumerable<string> values)
    {
        var keys = NormalizeVersionMemberNames(values);
        if (keys.Count == 0) return _ => null;
        var users = await _db.Users.Find(user => keys.Contains(user.UserId) || keys.Contains(user.DisplayName) || keys.Contains(user.Username))
            .Project(user => new { user.UserId, user.DisplayName, user.Username }).ToListAsync();
        var verifiedIds = users.Select(user => user.UserId).ToHashSet(StringComparer.Ordinal);
        var idsByName = users.SelectMany(user => new[] { user.DisplayName, user.Username }
                .Where(name => !string.IsNullOrWhiteSpace(name)).Select(name => (Name: name.Trim(), user.UserId)))
            .GroupBy(entry => entry.Name, StringComparer.Ordinal)
            .Select(group => (group.Key, Ids: group.Select(entry => entry.UserId).Distinct(StringComparer.Ordinal).ToArray()))
            .Where(entry => entry.Ids.Length == 1).ToDictionary(entry => entry.Key, entry => entry.Ids[0], StringComparer.Ordinal);
        return value =>
        {
            var key = value?.Trim();
            return key == null ? null : verifiedIds.Contains(key) ? key : idsByName.GetValueOrDefault(key);
        };
    }

    private async Task<ProductVersionListResult<T>> WithVersionExportFieldsAsync<T>(ProductVersionListResult<T> result,
        Func<T, VersionExportSource> select, Func<T, string>? protectReleaseOrigin = null)
    {
        var sources = result.Items.Select(row => select(row.Record)).ToArray();
        var verifiedId = await ResolveVersionPersonKeysAsync(sources.SelectMany(source =>
            source.MemberIds.Concat(source.MemberNames).Append(source.OwnerId ?? "").Append(source.OwnerName ?? "")));
        var productNames = await ProductNamesAsync(sources.Where(source => string.IsNullOrWhiteSpace(source.SystemName))
            .Select(source => source.ProductId));
        var applications = NormalizeVersionMemberNames(sources.Where(source => string.IsNullOrWhiteSpace(source.SystemName))
            .Select(source => productNames.GetValueOrDefault(source.ProductId) ?? source.ApplicationName ?? ""));
        var registry = await _db.VersionRegistryApplications.Find(app => applications.Contains(app.Name))
            .Project(app => new { app.Name, app.SystemName }).ToListAsync();
        var systems = registry.Where(app => !string.IsNullOrWhiteSpace(app.SystemName)).GroupBy(app => app.Name, StringComparer.Ordinal)
            .Select(group => (group.Key, Names: group.Select(app => app.SystemName).Distinct(StringComparer.Ordinal).ToArray()))
            .Where(entry => entry.Names.Length == 1).ToDictionary(entry => entry.Key, entry => entry.Names[0], StringComparer.Ordinal);

        return result with
        {
            Items = result.Items.Select((row, index) =>
            {
                var source = sources[index];
                var application = productNames.GetValueOrDefault(source.ProductId) ?? source.ApplicationName ?? "";
                var system = string.IsNullOrWhiteSpace(source.SystemName) ? systems.GetValueOrDefault(application) : source.SystemName;
                var members = NormalizeVersionMemberNames(source.MemberIds.Concat(source.MemberNames)
                    .Select(value => verifiedId(value) ?? ""));
                var origin = row.LegacyRegistration == null ? protectReleaseOrigin?.Invoke(row.Record) : null;
                return row with { ExportFields = new(system, verifiedId(source.OwnerId) ?? verifiedId(source.OwnerName), members, origin) };
            }).ToList(),
        };
    }
}
