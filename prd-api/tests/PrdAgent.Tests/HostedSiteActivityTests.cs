using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class HostedSiteActivityTests
{
    [Theory]
    [InlineData("published", "ai-edit", true, true)]
    [InlineData("published", "rollback", true, true)]
    [InlineData("published", "baseline", true, false)]
    [InlineData("draft", "ai-edit", false, false)]
    [InlineData("publishing", "ai-edit", true, false)]
    [InlineData("rejected", "ai-edit", true, false)]
    [InlineData("published", "ai-edit", false, false)]
    public void OnlyCompletedContentEditsCount(string status, string source, bool published, bool expected)
    {
        var revision = new HostedSiteRevision { Status = status, Source = source, PublishedAt = published ? DateTime.UtcNow : null };
        Assert.Equal(expected, HostedSiteActivityPolicy.PublishedEdit.Compile()(revision));
    }

    [Theory]
    [InlineData(0, false, true)]
    [InlineData(-7, false, true)]
    [InlineData(-8, false, false)]
    [InlineData(1, false, false)]
    [InlineData(0, true, false)]
    [InlineData(-7, true, false)]
    public void NewMeansRecentAndNotOpenedByCurrentViewer(int ageDays, bool opened, bool expected)
    {
        var now = new DateTime(2026, 11, 4, 12, 0, 0, DateTimeKind.Utc);
        Assert.Equal(expected, HostedSiteActivityPolicy.IsNew(now.AddDays(ageDays), opened, now));
    }
}
