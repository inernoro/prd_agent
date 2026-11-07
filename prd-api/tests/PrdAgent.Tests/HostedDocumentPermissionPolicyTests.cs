using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Tests;

public class HostedDocumentPermissionPolicyTests
{
    private static HostedSite Site(params string[] teams) => new()
    { OwnerUserId = "author", SharedTeamIds = teams.ToList(), Visibility = "private" };

    [Fact]
    public void TeamOrderDoesNotProduceFalsePermissionDifference()
    {
        var main = Site("product", "engineering");
        var target = Site("engineering", "product");
        Assert.True(HostedDocumentPermissionPolicy.SamePageAccess(main, target));
        Assert.Empty(HostedDocumentPermissionPolicy.DescribeChanges(main, target));
    }

    [Fact]
    public void PreviewSeparatesNewAccessFromRemovedAccess()
    {
        var changes = HostedDocumentPermissionPolicy.DescribeChanges(Site("product"), Site("external"));
        Assert.Contains("新增 1 个团队的访问权限", changes);
        Assert.Contains("移除 1 个团队的访问权限", changes);
        Assert.False(HostedDocumentPermissionPolicy.SamePageAccess(Site("product"), Site("external")));
    }

    [Fact]
    public void RestrictedGroupAndPublicListingAreIndependentPermissions()
    {
        var main = Site("product"); main.GroupId = "restricted";
        var target = Site("product"); target.Visibility = "public";
        Assert.False(HostedDocumentPermissionPolicy.SamePageAccess(main, target));
        var changes = HostedDocumentPermissionPolicy.DescribeChanges(main, target);
        Assert.Contains("同步团队分组及其访问限制", changes);
        Assert.Contains("关闭个人公开页展示", changes);
    }

    [Fact]
    public void SameTeamsNeverMakeAnotherOwnersDocumentEquivalent()
    {
        var main = Site("product");
        var target = Site("product"); target.OwnerUserId = "someone-else";
        Assert.False(HostedDocumentPermissionPolicy.SamePageAccess(main, target));
    }
}
