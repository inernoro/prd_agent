using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class HostedSiteCommentThreadTests
{
    [Fact]
    public void OldCommentDocument_RemainsAnUnresolvedPageDiscussion()
    {
        var old = new BsonDocument { { "_id", "legacy" }, { "SiteId", "site" }, { "Content", "整体建议" } };
        var comment = BsonSerializer.Deserialize<HostedSiteComment>(old);
        Assert.Null(comment.Anchor);
        Assert.Null(comment.ParentId);
        Assert.False(comment.IsResolved);
    }

    [Fact]
    public void Anchor_RoundTripsElementBindingAndTextContext()
    {
        var comment = new HostedSiteComment
        {
            SiteId = "site",
            Anchor = new HostedSiteCommentAnchor { Kind = "text", PagePath = "/lesson.html#intro",
                Selector = "#delivery", TagName = "P", Text = "三天交付", ElementText = "预计三天交付",
                Prefix = "预计", Suffix = "。", ContentVersion = "revision-1" },
        };
        Assert.True(HostedSiteCommentRules.IsValidAnchor(comment.Anchor));
        var restored = BsonSerializer.Deserialize<HostedSiteComment>(comment.ToBson());
        Assert.Equal("#delivery", restored.Anchor!.Selector);
        Assert.Equal("预计", restored.Anchor.Prefix);
        Assert.Equal("revision-1", restored.Anchor.ContentVersion);
    }

    [Theory]
    [InlineData("element", "", true)]
    [InlineData("text", "", false)]
    [InlineData("text", "内容", true)]
    [InlineData("script", "内容", false)]
    public void Anchor_RejectsUnsupportedKindsAndEmptyTextSelections(string kind, string text, bool valid)
    {
        Assert.Equal(valid, HostedSiteCommentRules.IsValidAnchor(new HostedSiteCommentAnchor
            { Kind = kind, PagePath = "/", Selector = "#hero", TagName = "DIV", Text = text }));
    }

    [Fact]
    public void Anchor_RejectsOversizedOrNullClientData()
    {
        var anchor = new HostedSiteCommentAnchor { PagePath = "/", Selector = "#hero", TagName = "DIV" };
        Assert.True(HostedSiteCommentRules.IsValidAnchor(anchor));
        anchor.Selector = new string('a', 2001);
        Assert.False(HostedSiteCommentRules.IsValidAnchor(anchor));
        anchor.Selector = "#hero";
        anchor.Prefix = null!;
        Assert.False(HostedSiteCommentRules.IsValidAnchor(anchor));
        Assert.True(HostedSiteCommentRules.IsValidAnchor(null));
    }

    [Theory]
    [InlineData("/lesson#intro", "H2", true)]
    [InlineData("/lesson", "custom-element", true)]
    [InlineData("https://other.example/", "DIV", false)]
    [InlineData("/lesson", "div,script", false)]
    [InlineData("/lesson", "*", false)]
    [InlineData("/lesson", "div[foo]", false)]
    public void Anchor_RequiresPagePathAndSingleTagName(string pagePath, string tagName, bool expected)
    {
        Assert.Equal(expected, HostedSiteCommentRules.IsValidAnchor(new HostedSiteCommentAnchor
            { PagePath = pagePath, Selector = "#hero", TagName = tagName }));
    }

    [Fact]
    public void Replies_OnlyAttachToLiveRootsInTheSameSite()
    {
        var parent = new HostedSiteComment { SiteId = "site-a" };
        Assert.True(HostedSiteCommentRules.CanReplyTo(parent, "site-a"));
        Assert.False(HostedSiteCommentRules.CanReplyTo(parent, "site-b"));
        parent.ParentId = "another-root";
        Assert.False(HostedSiteCommentRules.CanReplyTo(parent, "site-a"));
        parent.ParentId = null;
        parent.IsDeleted = true;
        Assert.False(HostedSiteCommentRules.CanReplyTo(parent, "site-a"));
        Assert.False(HostedSiteCommentRules.CanReplyTo(null, "site-a"));
    }

    [Fact]
    public void Resolution_RequiresRootAuthorOrSiteOwner()
    {
        var site = new HostedSite { OwnerUserId = "owner" };
        var comment = new HostedSiteComment { AuthorUserId = "author" };
        Assert.True(HostedSiteCommentRules.CanResolve(comment, site, "owner"));
        Assert.True(HostedSiteCommentRules.CanResolve(comment, site, "author"));
        Assert.False(HostedSiteCommentRules.CanResolve(comment, site, "member"));
        Assert.False(HostedSiteCommentRules.CanResolve(comment, site, null));
        comment.ParentId = "root";
        Assert.False(HostedSiteCommentRules.CanResolve(comment, site, "owner"));
        comment.ParentId = null;
        comment.IsDeleted = true;
        Assert.False(HostedSiteCommentRules.CanResolve(comment, site, "author"));
    }
}
