using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionListReaderTests
{
    private static readonly Product[] Products = { new() { Id = "app-a", Name = "互动营销" }, new() { Id = "app-b", Name = "防窜物流" } };

    [Fact]
    public void CurrentVersionWinsButSameCodeInAnotherApplicationRemains()
    {
        var current = new[] { new ProductRelease { Id = "current", ProductId = "app-a", VCode = "V1.0.0" } };
        var legacy = new[] {
            new VersionRegistration { Id = "duplicate", ApplicationName = "互动营销", Code = "v1.0.0" },
            new VersionRegistration { Id = "another", ApplicationName = "防窜物流", Code = "V1.0.0" },
        };
        var rows = ProductVersionListReader.MergeReleases(current, legacy, Products);
        Assert.Equal(2, rows.Count);
        Assert.Contains(rows, x => x.Record.Id == "current" && x.LegacyRegistration == null);
        Assert.Contains(rows, x => x.LegacyRegistration?.Id == "another" && x.Record.ProductId == "app-b");
    }

    [Fact]
    public void ImportedProductHistoryIsNotDuplicatedByTheLegacyRegistry()
    {
        var current = new[] { new ProductInitiation { Id = "imported", ProductId = "app-a", TCode = "T1.0.0", SourceType = "import" } };
        var legacy = new[] { new VersionRegistration { Id = "old", ApplicationName = "互动营销", Code = "T1.0.0" } };
        var row = Assert.Single(ProductVersionListReader.MergeInitiations(current, legacy, Products));
        Assert.Equal("imported", row.Record.Id);
        Assert.Null(row.LegacyRegistration);
    }

    [Fact]
    public void UnmatchedOrAmbiguousApplicationIsRetainedWithoutGuessingAProduct()
    {
        var legacy = new[] { new VersionRegistration { Id = "unknown", ApplicationName = "历史应用", Code = "T1.0.0" } };
        var row = Assert.Single(ProductVersionListReader.MergeInitiations(Array.Empty<ProductInitiation>(), legacy, Products));
        Assert.Equal(string.Empty, row.Record.ProductId);
        Assert.Equal("历史应用", row.Record.AppName);
        var ambiguous = new[] { new Product { Id = "a", Name = "历史应用" }, new Product { Id = "b", Name = "历史应用" } };
        Assert.Empty(Assert.Single(ProductVersionListReader.MergeInitiations(Array.Empty<ProductInitiation>(), legacy, ambiguous)).Record.ProductId);
    }

    [Fact]
    public void LegacyProjectionIsReadOnlyAndPreservesMinutesMembersAndCopyIdentity()
    {
        var legacy = new VersionRegistration {
            Id = "old", ApplicationName = "互动营销", Code = "V1.0.0", TCode = "T1.0.0",
            PlannedTrainingMinutes = 0, IsGlobalOpen = false, ProjectMemberNames = new() { "陈雅珊" },
        };
        var row = Assert.Single(ProductVersionListReader.MergeReleases(Array.Empty<ProductRelease>(), new[] { legacy }, Products));
        Assert.Equal("legacy:old", row.Record.Id);
        Assert.Equal("legacy_readonly", row.Record.Status);
        Assert.Null(row.Record.InitiationId);
        Assert.Null(row.Record.OwnerId);
        Assert.Equal(0, row.Record.PlannedTrainingMinutes);
        Assert.False(row.Record.IsGlobalOpen);
        Assert.Equal(legacy.ProjectMemberNames, row.Record.ProjectMemberNames);
        Assert.Same(legacy, row.LegacyRegistration);
    }

    [Fact]
    public void MissingApplicationOrCodeDoesNotCollapseUnprovenDuplicates()
    {
        var legacy = new[] {
            new VersionRegistration { Id = "a", Code = "T1.0.0" },
            new VersionRegistration { Id = "b", Code = "T1.0.0" },
            new VersionRegistration { Id = "c", ApplicationName = "互动营销", Code = "" },
            new VersionRegistration { Id = "d", ApplicationName = "互动营销", Code = "" },
        };
        Assert.Equal(4, ProductVersionListReader.MergeInitiations(Array.Empty<ProductInitiation>(), legacy, Products).Count);
    }
}
