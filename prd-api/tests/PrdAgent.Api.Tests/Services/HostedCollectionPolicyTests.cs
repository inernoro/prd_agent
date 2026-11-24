using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class HostedCollectionPolicyTests
{
    [Theory]
    [InlineData(null, false)]
    [InlineData("unselected", false)]
    [InlineData("selected", true)]
    [InlineData("creator", true)]
    public void SpecifiedAudienceDoesNotGrantAllLoggedInUsers(string? user, bool expected)
    {
        var snapshot = new HostedCollectionSnapshot { AccessUserIds = new() { "selected" } };
        Assert.Equal(expected, HostedCollectionPolicy.AudienceAllows(snapshot, user, "creator"));
    }
    [Fact]
    public void MainIsPinned_WithoutChangingOtherMemberOrder()
    {
        var collection = Make(); HostedCollectionPolicy.Validate(collection);
        Assert.Equal(new[] { "main", "a", "b" }, collection.SiteIds);
    }

    [Fact]
    public void ReplacingOrRemovingMainRequiresAnExistingMember()
    {
        var collection = Make(); collection.MainSiteId = "not-a-member";
        Assert.Throws<InvalidOperationException>(() => HostedCollectionPolicy.Validate(collection));
    }

    [Fact]
    public void SharesKeepIndependentMemberAndSectionSnapshots()
    {
        var collection = Make(); collection.Sections.Add(new() { Title = "方案", SiteIds = new() { "a", "b" } });
        var snapshot = HostedCollectionPolicy.Snapshot(collection, new() { "main", "a" });
        collection.SiteIds.Remove("a"); collection.Name = "后来修改"; collection.Sections[0].SiteIds.Clear();
        Assert.Equal("评审资料", snapshot.Name); Assert.Contains("a", snapshot.SiteIds);
        Assert.Equal(new[] { "a" }, snapshot.Sections[0].SiteIds);
        Assert.DoesNotContain("b", snapshot.SiteIds);
    }

    [Fact]
    public void ShareCannotExpandBeyondCollectionMembers()
        => Assert.Throws<InvalidOperationException>(() => HostedCollectionPolicy.Snapshot(Make(), new() { "outside" }));

    [Fact]
    public void SameDocumentCanBelongToIndependentCollections()
    {
        var first = Make(); var second = Make();
        HostedCollectionPolicy.Validate(first); HostedCollectionPolicy.Validate(second);
        Assert.NotEqual(first.Id, second.Id); Assert.Contains("a", first.SiteIds); Assert.Contains("a", second.SiteIds);
    }

    [Fact]
    public void SelectingSubsetPromotesMainOutsideChapterLists()
    {
        var collection = Make(); collection.Sections.Add(new() { Title = "方案", SiteIds = new() { "a", "b" } });
        var snapshot = HostedCollectionPolicy.Snapshot(collection, new() { "a", "b" });
        Assert.Equal("a", snapshot.MainSiteId);
        Assert.DoesNotContain(snapshot.MainSiteId, snapshot.Sections.SelectMany(s => s.SiteIds));
    }

    [Fact]
    public void ShareKeepsItsInvalidationGeneration()
    {
        var collection = Make(); collection.ShareGeneration = 2;
        var snapshot = HostedCollectionPolicy.Snapshot(collection, collection.SiteIds);
        collection.ShareGeneration++;
        Assert.Equal(2, snapshot.ShareGeneration);
        Assert.NotEqual(collection.ShareGeneration, snapshot.ShareGeneration);
    }

    [Theory]
    [InlineData("", "方案", false)]
    [InlineData("same", "", false)]
    [InlineData("same", "方案", true)]
    public void InvalidSectionIdentitiesAndNamesAreRejected(string id, string title, bool duplicate)
    {
        var collection = Make(); collection.Sections.Add(new() { Id = id, Title = title });
        if (duplicate) collection.Sections.Add(new() { Id = id, Title = "另一章" });
        Assert.Throws<InvalidOperationException>(() => HostedCollectionPolicy.Validate(collection));
    }

    [Fact]
    public void PublicationFreezesIndependentCaptionsAndSteps()
    {
        var state = new WritingDocumentState { Captions = new() { new() { Id = "caption", Text = "解释条件", At = 3 } },
            Chapters = new() { new() { Id = "chapter", Steps = new() { new() { Id = "step", Text = "执行操作", At = 5 } } } } };
        var publication = WritingDocumentPolicy.Snapshot(state, "reviewer", "审核人");
        state.Captions[0].Text = "之后编辑";
        Assert.Equal("解释条件", publication.Captions[0].Text);
        Assert.Equal("执行操作", publication.Chapters[0].Steps[0].Text);
        Assert.NotEqual(publication.Captions[0].At, publication.Chapters[0].Steps[0].At);
    }

    [Fact]
    public void StructuredReaderConditionsRequireHumanReview()
    {
        var state = new WritingDocumentState { Title = "条件", ReviewerId = "reviewer", Sections = new() { new() {
            Id = "section", Title = "操作", Condition = "仅在本部门适用", Paragraphs = new() { new() { Id = "p", Text = "执行操作", Status = "auth", Confirmed = true } }
        } } };
        Assert.Contains(WritingDocumentPolicy.SubmissionProblems(state), p => p.Contains("条件与细节"));
        state.Sections[0].MetadataConfirmed = true;
        Assert.Empty(WritingDocumentPolicy.SubmissionProblems(state));
    }

    [Fact]
    public void RemovedDocumentKeepsSafeIdentityInShareSnapshot()
    {
        var collection = Make(); collection.MemberMetadata["a"] = new() { Title = "技术方案", Author = "作者" };
        var snapshot = HostedCollectionPolicy.Snapshot(collection, new() { "main", "a" });
        collection.MemberMetadata["a"].Title = "之后重命名";
        Assert.Equal("技术方案", snapshot.MemberMetadata["a"].Title);
    }

    [Fact]
    public void NonOwnerCannotReadHiddenDocumentIdentityThroughRememberedMetadata()
    {
        var collection = Make(); collection.MemberMetadata["a"] = new() { Title = "受限预算", Author = "私有作者" };
        collection.MemberMetadata["main"] = new() { Title = "公开总览" };
        collection.Sections.Add(new() { Title = "私有章节", SiteIds = new() { "a" } });
        HostedCollectionPolicy.RestrictVisibleMembers(collection, new HashSet<string> { "main" });
        var json = System.Text.Json.JsonSerializer.Serialize(collection);
        Assert.DoesNotContain("受限预算", json); Assert.DoesNotContain("私有作者", json);
        Assert.Equal(new[] { "main" }, collection.SiteIds); Assert.Equal(new[] { "main" }, collection.MemberMetadata.Keys); Assert.Empty(collection.Sections);
    }

    private static HostedDocumentCollection Make() => new() {
        Name = "评审资料", MainSiteId = "main", SiteIds = new() { "a", "main", "b" }
    };
}
