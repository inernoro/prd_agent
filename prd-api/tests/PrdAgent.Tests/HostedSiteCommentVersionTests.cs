using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

public class HostedSiteCommentVersionTests
{
    [Theory]
    [InlineData(null, false, false)]
    [InlineData("previous", false, false)]
    [InlineData("previous", true, true)]
    [InlineData(null, true, true)]
    public void ExternalShare_DoesNotGrantHistoricalCommentAccess(string? version, bool editor, bool allowed)
    {
        var current = new DateTime(2026, 11, 4, 0, 0, 0, DateTimeKind.Utc);
        Assert.Equal(allowed, HostedSiteCommentRules.CanViewReviewVersion(version, current, editor));
        Assert.True(HostedSiteCommentRules.CanViewReviewVersion(HostedSiteCommentRules.VersionKey(current), current, false));
    }

    [Fact]
    public void BoundLegacyComment_NormalizesUrlTicksToMongoPrecision()
    {
        var version = new DateTime(2026, 11, 4, 10, 0, 0, DateTimeKind.Utc).AddTicks(12345);
        var comment = new HostedSiteComment { Anchor = new HostedSiteCommentAnchor { ContentVersion = version.Ticks.ToString() } };
        Assert.Equal(HostedSiteCommentRules.VersionKey(version), HostedSiteCommentRules.StoredVersion(comment));
        Assert.EndsWith("0000", HostedSiteCommentRules.StoredVersion(comment));
    }

    [Fact]
    public void ExplicitVersion_WinsOverLegacyAnchorAndPageCommentsRemainUnversioned()
    {
        var comment = new HostedSiteComment { ContentVersion = "frozen-version", Anchor = new HostedSiteCommentAnchor { ContentVersion = "639293822977070331" } };
        Assert.Equal("frozen-version", HostedSiteCommentRules.StoredVersion(comment));
        Assert.Null(HostedSiteCommentRules.StoredVersion(new HostedSiteComment()));
        Assert.Null(HostedSiteCommentRules.StoredVersion(new HostedSiteComment { Anchor = new HostedSiteCommentAnchor { ContentVersion = "invalid" } }));
    }

    [Theory]
    [InlineData("published", "site", true)]
    [InlineData("published", "other-site", false)]
    [InlineData("draft", "site", false)]
    [InlineData("publishing", "site", false)]
    [InlineData("rejected", "site", false)]
    public void CommentTarget_OnlyAllowsPublishedRevisionInSameSite(string status, string revisionSite, bool expected)
    {
        var revision = new HostedSiteRevision { SiteId = revisionSite, Status = status, PublishedContentVersion = DateTime.UtcNow };
        Assert.Equal(expected, HostedSiteCommentRules.IsPublishedVersion(revision, "site"));
        revision.PublishedContentVersion = null;
        Assert.False(HostedSiteCommentRules.IsPublishedVersion(revision, "site"));
        Assert.False(HostedSiteCommentRules.IsPublishedVersion(null, "site"));
    }

    [Theory]
    [InlineData(null, "current", true)]
    [InlineData("current", "current", true)]
    [InlineData("previous", "current", false)]
    [InlineData("", "current", false)]
    public void StaleView_CannotSilentlySaveIntoCurrentVersion(string? expected, string actual, bool accepted) =>
        Assert.Equal(accepted, HostedSiteCommentRules.MatchesExpectedVersion(expected, actual));

    [Theory]
    [InlineData("https://example.com/index.html?v=123", "https://example.com/index.html?v=123&_map_bridge=9")]
    [InlineData("/index.html?v=123&_map_bridge=8#intro", "/index.html?v=123&_map_bridge=9#intro")]
    [InlineData("/index.html?_map_bridge=8&v=123", "/index.html?v=123&_map_bridge=9")]
    public void RuntimeUpgrade_ChangesCacheKeyWithoutChangingBusinessVersion(string before, string expected)
    {
        Assert.Equal(expected, HostedSiteService.AppendBridgeVersion(before, 9));
        Assert.Equal(expected, HostedSiteService.AppendBridgeVersion(expected, 9));
    }
}
