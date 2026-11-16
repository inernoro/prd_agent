using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class HostedCollectionRulesTests
{
    [Fact]
    public void ExplicitMainIsPinnedWithoutChangingOtherMembersOrSourceList()
    {
        var source = new[] { "third", "second", "first", "second", "" };
        Assert.Equal(new[] { "first", "third", "second" }, HostedCollectionRules.OrderedIds(source, "first"));
        Assert.Equal("third", source[0]);
        Assert.Equal(new[] { "third", "second", "first" }, HostedCollectionRules.OrderedIds(source, "deleted-main"));
    }

    [Fact]
    public void CollectionRequiresNameExplicitMemberMainAndBoundedMembership()
    {
        var ids = Enumerable.Range(1, 90).Select(x => x.ToString()).ToList();
        Assert.Null(HostedCollectionRules.Validate("项目资料", ids, "90"));
        Assert.NotNull(HostedCollectionRules.Validate(" ", ids, "90"));
        Assert.NotNull(HostedCollectionRules.Validate("项目资料", ids, null));
        Assert.NotNull(HostedCollectionRules.Validate("项目资料", ids, "outside"));
        Assert.NotNull(HostedCollectionRules.Validate("项目资料", ids.Append("91").ToList(), "90"));
    }

    [Fact]
    public void EditingCollectionDoesNotSilentlyReplacePublishedSnapshot()
    {
        var collection = new HostedCollection { Id = "c", SiteIds = new() { "main", "new" }, Version = 2 };
        var share = new WebPageShareLink { CollectionId = "c", SiteIds = new() { "old", "main" }, CollectionVersion = 1 };
        Assert.True(HostedCollectionRules.AllowsShare(collection, share));
        Assert.Equal(new[] { "old", "main" }, share.SiteIds);
        collection.ShareGeneration++;
        // An old-generation write that finishes after stop-sharing cannot revive the link.
        Assert.False(HostedCollectionRules.AllowsShare(collection, share));
        share.CollectionShareGeneration = collection.ShareGeneration;
        Assert.True(HostedCollectionRules.AllowsShare(collection, share));
        collection.IsDissolved = true;
        Assert.False(HostedCollectionRules.AllowsShare(collection, share));
        Assert.False(HostedCollectionRules.AllowsShare(null, share));
        Assert.False(HostedCollectionRules.AllowsShare(new HostedCollection { Id = "another" }, share));
    }
}
