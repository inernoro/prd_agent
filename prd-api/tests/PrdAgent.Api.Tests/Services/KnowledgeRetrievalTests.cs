using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class KnowledgeRetrievalTests
{
    private const string Model = "test-embedding";
    private static readonly float[] Query = { 1, 0 };

    [Fact]
    public void PrivateSourcesNeverEnterResultsEvenWithPerfectSimilarity()
    {
        var owned = Doc("owned", "owner", false, "可见依据");
        var secret = Doc("secret", "someone-else", false, "绝密依据");
        var hits = Rank(new[] { Row(owned), Row(secret) }, new[] { owned, secret });
        Assert.Equal("owned", Assert.Single(hits).Entry.Id);
    }

    [Fact]
    public void PublicSourceIsReadableButRevocationTakesEffectOnNextRanking()
    {
        var source = Doc("shared", "someone-else", true, "公开依据");
        var row = Row(source);
        Assert.Single(Rank(new[] { row }, new[] { source }));
        source.Store.IsPublic = false;
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    [Fact]
    public void DeletedEntryAndDeletedStoreCannotBeReturnedFromRetainedVectors()
    {
        var source = Doc("deleted", "owner", false, "已删除正文");
        Assert.Empty(Rank(new[] { Row(source) }, Array.Empty<KnowledgeRetrievalDocument>()));
    }

    [Fact]
    public void UpdatingBodyImmediatelyExcludesStaleChunkWithoutReindex()
    {
        var original = Doc("edited", "owner", false, "报销上限是五百元。");
        var row = Row(original);
        var updated = original with { Content = "报销上限现为三百元。" };
        Assert.Empty(Rank(new[] { row }, new[] { updated }));
        Assert.Single(Rank(new[] { Row(updated) }, new[] { updated }));
    }

    [Fact]
    public void TamperedTextCannotPassCurrentContentHashCheck()
    {
        var source = Doc("entry", "owner", false, "真实原文");
        var row = Row(source);
        row.Text = "伪造原文";
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    [Theory]
    [InlineData("other-model", 2)]
    [InlineData(Model, 3)]
    public void SameDimensionOtherModelAndWrongDimensionAreExcluded(string model, int dimension)
    {
        var source = Doc("entry", "owner", false, "真实原文");
        var row = Row(source);
        row.Model = model;
        row.Dimension = dimension;
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    [Fact]
    public void PreviewAndProductionCannotReadEachOthersVectors()
    {
        var source = Doc("entry", "owner", false, "真实原文");
        var row = Row(source);
        row.DeploymentSlug = "another-preview";
        Assert.Empty(Rank(new[] { row }, new[] { source }));
        Assert.Single(KnowledgeRetrievalService.RankCurrent(new[] { row }, new[] { source },
            "owner", Model, Query, 5, "another-preview"));
    }

    [Fact]
    public void TopFiveContainsFiveDistinctDocumentsInsteadOfFiveChunksFromOne()
    {
        var docs = Enumerable.Range(0, 7).Select(i => Doc($"entry-{i}", "owner", false, $"依据{i}")).ToArray();
        var repeated = Enumerable.Repeat(Row(docs[0]), 8).Concat(docs.Skip(1).Select(doc => Row(doc)));
        var hits = Rank(repeated, docs);
        Assert.Equal(5, hits.Count);
        Assert.Equal(5, hits.Select(x => x.Entry.Id).Distinct().Count());
    }

    [Fact]
    public void NoRelevantVectorReturnsNoEvidenceAndDoesNotPromoteLowScore()
    {
        var source = Doc("entry", "owner", false, "无关内容");
        var row = Row(source);
        row.Vector = EmbeddingVector.Encode(new float[] { 0, 1 });
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    [Fact]
    public void CorruptBytesAndFolderEntriesAreExcluded()
    {
        var source = Doc("entry", "owner", false, "真实正文");
        var row = Row(source);
        row.Vector = new byte[1];
        Assert.Empty(Rank(new[] { row }, new[] { source }));
        row = Row(source);
        source.Entry.IsFolder = true;
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    [Fact]
    public void WrongStoreAssociationCannotExposeEvenOwnedEntry()
    {
        var source = Doc("entry", "owner", false, "真实正文");
        var row = Row(source);
        row.StoreId = "other-store";
        Assert.Empty(Rank(new[] { row }, new[] { source }));
    }

    private static IReadOnlyList<KnowledgeRetrievalHit> Rank(IEnumerable<DocumentEmbedding> rows,
        IEnumerable<KnowledgeRetrievalDocument> docs)
        => KnowledgeRetrievalService.RankCurrent(rows, docs, "owner", Model, Query, 5, null);

    private static KnowledgeRetrievalDocument Doc(string id, string owner, bool isPublic, string content)
    {
        var store = new DocumentStore { Id = "store-" + id, OwnerId = owner, IsPublic = isPublic };
        var entry = new DocumentEntry { Id = id, StoreId = store.Id, Title = id };
        return new KnowledgeRetrievalDocument(store, entry, content);
    }

    private static DocumentEmbedding Row(KnowledgeRetrievalDocument doc) => new()
    {
        StoreId = doc.Store.Id, EntryId = doc.Entry.Id, Text = doc.Content,
        ContentHash = DocumentChunker.ComputeHash(doc.Content, Model), Model = Model, Dimension = 2,
        Vector = EmbeddingVector.Encode(Query)
    };
}
