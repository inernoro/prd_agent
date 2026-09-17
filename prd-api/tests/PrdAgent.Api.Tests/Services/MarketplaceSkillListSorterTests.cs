using PrdAgent.Api.Controllers.Api.MarketplaceSkills;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class MarketplaceSkillListSorterTests
{
    [Fact]
    public void NewSort_UsesUpdatedAtAcrossOfficialAndCommunityItems()
    {
        var candidates = new[]
        {
            Candidate("newly-created", "2026-09-16", "2026-09-16", 0),
            Candidate("recently-updated", "2026-04-01", "2026-09-17", 0),
        };

        var result = MarketplaceSkillListSorter.SortAndTake(candidates, "new", 50);

        Assert.Equal(new[] { "recently-updated", "newly-created" }, result.Cast<string>());
    }

    [Fact]
    public void HotSort_UsesDownloadsAndAlwaysHonorsLimit()
    {
        var candidates = new[]
        {
            Candidate("quiet", "2026-09-17", "2026-09-17", 1),
            Candidate("popular", "2026-04-01", "2026-04-01", 10),
            Candidate("middle", "2026-06-01", "2026-06-01", 5),
        };

        var result = MarketplaceSkillListSorter.SortAndTake(candidates, "hot", 2);

        Assert.Equal(new[] { "popular", "middle" }, result.Cast<string>());
    }

    [Fact]
    public void AsUtc_ConvertsLocalValuesInsteadOfOnlyRelabelingThem()
    {
        var local = new DateTime(2026, 9, 17, 12, 0, 0, DateTimeKind.Local);

        var result = MarketplaceSkillListSorter.AsUtc(local);

        Assert.Equal(local.ToUniversalTime(), result.UtcDateTime);
        Assert.Equal(TimeSpan.Zero, result.Offset);
    }

    private static MarketplaceSkillListSorter.Candidate Candidate(
        string id,
        string createdAt,
        string updatedAt,
        long downloads) => new(
            id,
            DateTimeOffset.Parse(createdAt),
            DateTimeOffset.Parse(updatedAt),
            downloads);
}
